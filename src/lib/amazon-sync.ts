import { fetchOrderStatuses, EASYSHIP_NOT_YET_COLLECTED, type AmazonEnv } from './amazon';
import { releaseReservation } from './inventory';
import { logAudit, logException } from './db';

export interface SyncResult {
  checked: number;
  shipped: number;
  cancelled: number;
}

/**
 * Pulls current status for every local Amazon order that isn't already
 * `shipped`/`cancelled` and reconciles it. Amazon is treated as authoritative
 * only for the two terminal states — everything else (batched/picking/
 * picked/packing/packed/ready_to_ship) is *our* floor-progress tracking,
 * which Amazon has no visibility into and must never get regressed by a
 * coarser Amazon status. This is also the only place `orders.status` ever
 * actually reaches `'shipped'` — nothing in the pick/pack/ship flow set it
 * directly before this existed, since "shipped" is a real-world carrier
 * event, not something we can claim ourselves.
 *
 * `OrderStatus: "Shipped"` alone is NOT trusted for an Easy Ship order — a
 * real production bug (see HANDOFF.md): Amazon flips it the moment a pickup
 * is *scheduled*, not when the courier actually collects the package, so an
 * order could sit fully picked but never packed in this system while Amazon
 * had already told us it was "Shipped," silently pulling it out of the
 * active pick/pack pipeline days before the box actually left the building.
 * `EasyShipShipmentStatus` (only present for Easy Ship orders) is checked
 * first — while it's still `PendingSchedule`/`PendingPickUp`/`PendingDropOff`
 * (see EASYSHIP_NOT_YET_COLLECTED, amazon.ts), the box is still physically
 * with the seller, so the order is left exactly as our own floor-progress
 * tracking has it, "Shipped" or not.
 *
 * Also keeps `orders.amazon_order_status` current on every order checked
 * (not just ones going shipped/cancelled) — a user request (see HANDOFF.md):
 * `reserveOrderForPicking` holds a "Pending" order out of the pick list even
 * on its ship-by day, since Amazon could still cancel it before ever
 * confirming it. This runs right before `retryBlockedOrders` in the same
 * cron cycle (see sync-job.ts), so an order that just flipped from Pending
 * to Unshipped/PartiallyShipped here becomes reservable in the very same
 * pass, with no separate scheduler needed.
 *
 * Also persists `orders.easyship_status` (raw EasyShipShipmentStatus) so the
 * admin orders page can split "Sent" into "Waiting for pickup" vs "Shipped"
 * the way Seller Central does — see admin-orders.ts. Only updated while the
 * order is still in this function's WHERE clause (not yet our own
 * 'shipped'/'cancelled'), so it stops advancing once picked up/dropped off
 * flips the order to 'shipped' above; it won't keep tracking through to
 * "Delivered" afterward. That's an accepted gap, not a bug — re-syncing
 * already-terminal orders just to chase a display label isn't worth the
 * extra GetOrders calls this account already worried about rate limits on.
 */
export async function syncOrderStatuses(db: D1Database, warehouseId: string, credentials?: Partial<AmazonEnv>): Promise<SyncResult> {
  const unresolved = await db
    .prepare(`SELECT id, external_order_id FROM orders WHERE warehouse_id = ? AND source = 'amazon' AND status NOT IN ('shipped', 'cancelled')`)
    .bind(warehouseId)
    .all<{ id: string; external_order_id: string }>();

  if (!unresolved.results.length) {
    return { checked: 0, shipped: 0, cancelled: 0 };
  }

  const statuses = await fetchOrderStatuses(unresolved.results.map((o) => o.external_order_id), credentials);
  let shipped = 0;
  let cancelled = 0;

  for (const order of unresolved.results) {
    const amazonStatus = statuses.get(order.external_order_id);
    if (!amazonStatus) continue;
    await db
      .prepare(`UPDATE orders SET amazon_order_status = ?, easyship_status = ? WHERE id = ?`)
      .bind(amazonStatus.orderStatus, amazonStatus.easyShipShipmentStatus ?? null, order.id)
      .run();

    const stillWithSeller = amazonStatus.easyShipShipmentStatus && EASYSHIP_NOT_YET_COLLECTED.has(amazonStatus.easyShipShipmentStatus);

    if (amazonStatus.orderStatus === 'Shipped' && !stillWithSeller) {
      await db.prepare(`UPDATE orders SET status = 'shipped' WHERE id = ?`).bind(order.id).run();
      await closeOutOpenPicking(db, order.id);
      await logAudit(db, { userId: null, action: 'order.shipped_sync', entityType: 'order', entityId: order.id, metadata: { source: 'amazon_status_sync' } });
      shipped++;
    } else if (amazonStatus.orderStatus === 'Canceled') {
      await cancelOrderFromSync(db, order.id);
      cancelled++;
    }
  }

  return { checked: unresolved.results.length, shipped, cancelled };
}

/**
 * Real production incident (see HANDOFF.md): a batch of backlog orders got
 * imported and reserved (spawning a pick_batch/pick_tasks via
 * reserveOrderForPicking) in the same cron cycle that then discovered, via
 * this very sync, that Amazon already considered them Shipped/PickedUp —
 * meaning the physical units left the building through some channel other
 * than this WMS's own pick/pack flow (a backlog catch-up, most likely).
 * Nothing closed out the batch/tasks that had *already* been created
 * moments earlier, so they sat forever in a picker's active queue for an
 * order that was, per Amazon, done. `syncOrderStatuses` must never let an
 * order become 'shipped' while leaving open pick_tasks/pick_batches behind
 * — this mirrors cancelOrderFromSync's cleanup (release the reservation,
 * mark the tasks resolved, log it for a human to notice) but keeps
 * orders.status at 'shipped' rather than overwriting it.
 */
async function closeOutOpenPicking(db: D1Database, orderId: string): Promise<void> {
  const openTasks = await db
    .prepare(
      `SELECT pt.id, pt.sku_id, pt.location_id, pt.quantity_required, pt.pick_batch_id
       FROM pick_tasks pt JOIN order_items oi ON oi.id = pt.order_item_id
       WHERE oi.order_id = ? AND pt.status IN ('pending', 'location_confirmed')`
    )
    .bind(orderId)
    .all<{ id: string; sku_id: string; location_id: string; quantity_required: number; pick_batch_id: string }>();

  if (!openTasks.results.length) return;

  const affectedBatchIds = new Set<string>();
  for (const task of openTasks.results) {
    const inv = await db
      .prepare(`SELECT id FROM inventory WHERE sku_id = ? AND location_id = ?`)
      .bind(task.sku_id, task.location_id)
      .first<{ id: string }>();
    if (inv) await releaseReservation(db, inv.id, task.quantity_required);
    await db.prepare(`UPDATE pick_tasks SET status = 'cancelled' WHERE id = ?`).bind(task.id).run();
    affectedBatchIds.add(task.pick_batch_id);
  }

  // A batch is done once nothing in it is still pending/location_confirmed —
  // same completion rule as checkBatchCompletion (picker.ts), reimplemented
  // here rather than reused because that function also forces
  // orders.status to 'picked', which would stomp the 'shipped' this sync
  // just set.
  for (const batchId of affectedBatchIds) {
    const remaining = await db
      .prepare(`SELECT COUNT(*) AS c FROM pick_tasks WHERE pick_batch_id = ? AND status IN ('pending', 'location_confirmed')`)
      .bind(batchId)
      .first<{ c: number }>();
    if ((remaining?.c ?? 0) === 0) {
      await db.prepare(`UPDATE pick_batches SET status = 'completed', completed_at = datetime('now') WHERE id = ?`).bind(batchId).run();
    }
  }

  await logException(db, {
    type: 'shipped_before_picked',
    orderId,
    userId: null,
    notes: `Amazon reports this order already Shipped/PickedUp, but ${openTasks.results.length} pick task(s) were still open in this WMS — closed out and reservation released. The units likely left through a channel outside normal pick/pack; verify physical stock if this is unexpected.`
  });
}

/**
 * Amazon cancelled an order out from under us. Auto-releases the reservation
 * for anything not yet physically picked (the common case — safe, since the
 * stock never actually left the shelf). Anything already picked/packed is
 * left inventory-wise as-is: the system has no idea which cart/station the
 * physical unit is sitting in, so silently incrementing stock back up would
 * just be wrong. Instead it logs an `order_cancelled` exception so a human
 * sees it and does the physical putback.
 */
async function cancelOrderFromSync(db: D1Database, orderId: string): Promise<void> {
  await db.prepare(`UPDATE orders SET status = 'cancelled' WHERE id = ?`).bind(orderId).run();

  const openTasks = await db
    .prepare(
      `SELECT pt.id, pt.sku_id, pt.location_id, pt.quantity_required, pt.status
       FROM pick_tasks pt JOIN order_items oi ON oi.id = pt.order_item_id
       WHERE oi.order_id = ? AND pt.status IN ('pending', 'location_confirmed')`
    )
    .bind(orderId)
    .all<{ id: string; sku_id: string; location_id: string; quantity_required: number; status: string }>();

  for (const task of openTasks.results) {
    const inv = await db
      .prepare(`SELECT id FROM inventory WHERE sku_id = ? AND location_id = ?`)
      .bind(task.sku_id, task.location_id)
      .first<{ id: string }>();
    if (inv) await releaseReservation(db, inv.id, task.quantity_required);
    await db.prepare(`UPDATE pick_tasks SET status = 'cancelled' WHERE id = ?`).bind(task.id).run();
  }

  const alreadyPicked = await db
    .prepare(
      `SELECT COUNT(*) AS c FROM pick_tasks pt JOIN order_items oi ON oi.id = pt.order_item_id
       WHERE oi.order_id = ? AND pt.status = 'picked'`
    )
    .bind(orderId)
    .first<{ c: number }>();

  await logException(db, {
    type: 'order_cancelled',
    orderId,
    userId: null,
    notes:
      alreadyPicked && alreadyPicked.c > 0
        ? `Cancelled by Amazon after ${alreadyPicked.c} line(s) already picked — needs manual return to stock.`
        : 'Cancelled by Amazon before picking started — reservation auto-released.'
  });
  await logAudit(db, { userId: null, action: 'order.cancelled_sync', entityType: 'order', entityId: orderId, metadata: { source: 'amazon_status_sync' } });
}
