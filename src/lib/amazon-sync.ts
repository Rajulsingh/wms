import { fetchOrderStatuses } from './amazon';
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
 */
export async function syncOrderStatuses(db: D1Database, warehouseId: string): Promise<SyncResult> {
  const unresolved = await db
    .prepare(`SELECT id, external_order_id FROM orders WHERE warehouse_id = ? AND source = 'amazon' AND status NOT IN ('shipped', 'cancelled')`)
    .bind(warehouseId)
    .all<{ id: string; external_order_id: string }>();

  if (!unresolved.results.length) {
    return { checked: 0, shipped: 0, cancelled: 0 };
  }

  const statuses = await fetchOrderStatuses(unresolved.results.map((o) => o.external_order_id));
  let shipped = 0;
  let cancelled = 0;

  for (const order of unresolved.results) {
    const amazonStatus = statuses.get(order.external_order_id);
    if (amazonStatus === 'Shipped') {
      await db.prepare(`UPDATE orders SET status = 'shipped' WHERE id = ?`).bind(order.id).run();
      await logAudit(db, { userId: null, action: 'order.shipped_sync', entityType: 'order', entityId: order.id, metadata: { source: 'amazon_status_sync' } });
      shipped++;
    } else if (amazonStatus === 'Canceled') {
      await cancelOrderFromSync(db, order.id);
      cancelled++;
    }
  }

  return { checked: unresolved.results.length, shipped, cancelled };
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
