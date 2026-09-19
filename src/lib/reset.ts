import { releaseReservation } from './inventory';
import { logAudit } from './db';

export interface ResetResult {
  orderCount: number;
  batchCount: number;
}

/**
 * Admin "start over" button for testing: reverts every order currently
 * mid-pipeline (batched through partial — anything picking/packing has
 * touched) back to 'pending', undoes what picking/packing did to inventory
 * (restores on-hand units confirmPick consumed, releases outstanding
 * reservations, un-marks bins reportDamaged flagged), and deletes the
 * pick/pack rows themselves so the next "create batch" / claim starts clean.
 *
 * Stops at the shipping-label boundary by default: orders already at
 * 'ready_to_ship' are left untouched, since one may carry a REAL
 * Amazon-scheduled pickup/label (see applyAwbByScan's pre-purchased-label path
 * in packer.ts) — resetting it would desync us from a commitment Amazon
 * already has, not just clear local test state. `includeReadyToShip` is an
 * explicit opt-in (a checkbox on the admin button, defaulting off) for when
 * that's exactly what's wanted anyway — e.g. retesting a fully-completed
 * order end to end. 'shipped' (a real carrier event, never ours to
 * self-report — see amazon-sync.ts) and 'cancelled' orders are never
 * touched either way. See HANDOFF.md.
 */
export async function resetPickPackData(db: D1Database, warehouseId: string, userId: string, includeReadyToShip = false): Promise<ResetResult> {
  const statuses = includeReadyToShip
    ? ['allocated', 'batched', 'picking', 'picked', 'packing', 'packed', 'partial', 'ready_to_ship']
    : ['allocated', 'batched', 'picking', 'picked', 'packing', 'packed', 'partial'];
  const statusPh = statuses.map(() => '?').join(',');
  const targetOrders = await db
    .prepare(`SELECT id FROM orders WHERE warehouse_id = ? AND status IN (${statusPh})`)
    .bind(warehouseId, ...statuses)
    .all<{ id: string }>();
  const orderIds = targetOrders.results.map((r) => r.id);
  if (!orderIds.length) return { orderCount: 0, batchCount: 0 };
  const orderPh = orderIds.map(() => '?').join(',');

  const pickTasks = await db
    .prepare(
      `SELECT pt.id, pt.pick_batch_id, pt.status, pt.sku_id, pt.location_id, pt.quantity_required, pt.quantity_picked
       FROM pick_tasks pt JOIN order_items oi ON oi.id = pt.order_item_id
       WHERE oi.order_id IN (${orderPh})`
    )
    .bind(...orderIds)
    .all<{ id: string; pick_batch_id: string; status: string; sku_id: string; location_id: string; quantity_required: number; quantity_picked: number }>();
  const batchIds = [...new Set(pickTasks.results.map((t) => t.pick_batch_id))];

  // Undo each pick_task's effect on inventory before deleting it — a
  // still-open task holds a reservation to release, a resolved 'picked'/
  // 'short' task consumed real on-hand units to put back, a 'damaged' task
  // flagged its whole bin unavailable to lift.
  for (const t of pickTasks.results) {
    const inv = await db.prepare(`SELECT id FROM inventory WHERE sku_id = ? AND location_id = ?`).bind(t.sku_id, t.location_id).first<{ id: string }>();
    if (!inv) continue;
    if (t.status === 'pending' || t.status === 'location_confirmed') {
      await releaseReservation(db, inv.id, t.quantity_required);
    } else if ((t.status === 'picked' || t.status === 'short') && t.quantity_picked > 0) {
      await db
        .prepare(`UPDATE inventory SET quantity_on_hand = quantity_on_hand + ?, version = version + 1, updated_at = datetime('now') WHERE id = ?`)
        .bind(t.quantity_picked, inv.id)
        .run();
    } else if (t.status === 'damaged') {
      await db.prepare(`UPDATE inventory SET status = 'available', version = version + 1, updated_at = datetime('now') WHERE id = ?`).bind(inv.id).run();
    }
  }

  // The scan log is deliberately permanent record-keeping (see
  // applyAwbByScan in packer.ts) — never deleted, but its FK references to
  // orders/shipments about to disappear here have to be cleared first,
  // same pattern already used for exception_events below.
  await db.prepare(`UPDATE awb_scans SET order_id = NULL WHERE order_id IN (${orderPh})`).bind(...orderIds).run();

  // Packing rows for these orders — child tables first to satisfy FKs.
  const packSessions = await db.prepare(`SELECT id FROM pack_sessions WHERE order_id IN (${orderPh})`).bind(...orderIds).all<{ id: string }>();
  const sessionIds = packSessions.results.map((s) => s.id);
  if (sessionIds.length) {
    const sessionPh = sessionIds.map(() => '?').join(',');
    const packages = await db.prepare(`SELECT id FROM packages WHERE pack_session_id IN (${sessionPh})`).bind(...sessionIds).all<{ id: string }>();
    const packageIds = packages.results.map((p) => p.id);
    if (packageIds.length) {
      const packagePh = packageIds.map(() => '?').join(',');
      await db
        .prepare(`UPDATE awb_scans SET shipment_id = NULL WHERE shipment_id IN (SELECT id FROM shipments WHERE package_id IN (${packagePh}))`)
        .bind(...packageIds)
        .run();
      await db.prepare(`DELETE FROM awbs WHERE shipment_id IN (SELECT id FROM shipments WHERE package_id IN (${packagePh}))`).bind(...packageIds).run();
      await db.prepare(`DELETE FROM shipments WHERE package_id IN (${packagePh})`).bind(...packageIds).run();
      await db.prepare(`DELETE FROM packages WHERE id IN (${packagePh})`).bind(...packageIds).run();
    }
    await db.prepare(`UPDATE exception_events SET pack_session_id = NULL WHERE pack_session_id IN (${sessionPh})`).bind(...sessionIds).run();
    await db.prepare(`DELETE FROM pack_sessions WHERE id IN (${sessionPh})`).bind(...sessionIds).run();
  }

  // Picking rows.
  const taskIds = pickTasks.results.map((t) => t.id);
  if (taskIds.length) {
    const taskPh = taskIds.map(() => '?').join(',');
    await db.prepare(`UPDATE exception_events SET pick_task_id = NULL WHERE pick_task_id IN (${taskPh})`).bind(...taskIds).run();
    await db.prepare(`DELETE FROM pick_tasks WHERE id IN (${taskPh})`).bind(...taskIds).run();
  }
  if (batchIds.length) {
    const batchPh = batchIds.map(() => '?').join(',');
    await db.prepare(`DELETE FROM cart_slots WHERE pick_batch_id IN (${batchPh})`).bind(...batchIds).run();
    await db.prepare(`DELETE FROM pick_batches WHERE id IN (${batchPh})`).bind(...batchIds).run();
  }

  // Orders/items back to a fresh, batchable state. The final UPDATE is
  // re-guarded by the same status list the initial SELECT used (not just
  // `id IN (...)`) — a real incident showed why: reset takes a snapshot of
  // target orders, then does many sequential awaited writes; if any of
  // those orders finish picking/packing for real (concurrent floor
  // activity) before this line runs, a blind `id IN (...)` UPDATE stomps
  // that real progress back to 'pending' while leaving its now-orphaned
  // pick_tasks/pack_sessions untouched (they were captured earlier, before
  // the concurrent change) — exactly the corruption that hid 35 already-
  // picked orders from the packer and made "retry blocked" report bogus
  // stock shortages. Re-checking status here means an order that moved on
  // mid-reset is simply left alone instead of getting silently mislabeled.
  await db.prepare(`UPDATE order_items SET quantity_picked = 0, quantity_packed = 0, status = 'pending' WHERE order_id IN (${orderPh})`).bind(...orderIds).run();
  await db.prepare(`UPDATE orders SET status = 'pending' WHERE id IN (${orderPh}) AND status IN (${statusPh})`).bind(...orderIds, ...statuses).run();

  await logAudit(db, {
    userId,
    action: 'admin.reset_pick_pack',
    entityType: 'warehouse',
    entityId: warehouseId,
    metadata: { orderCount: orderIds.length, batchCount: batchIds.length, includeReadyToShip }
  });

  return { orderCount: orderIds.length, batchCount: batchIds.length };
}
