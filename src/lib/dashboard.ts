import { getUnbatchedOrderSummary } from './orders';

// Every real value orders.status can hold (migration 0001's CHECK) — shown
// as zero rather than omitted so the UI never has to guess whether a status
// with no current orders means "none" or "not fetched yet".
const ORDER_STATUSES = [
  'pending',
  'allocated',
  'batched',
  'picking',
  'picked',
  'packing',
  'packed',
  'partial',
  'ready_to_ship',
  'shipped',
  'cancelled'
] as const;

export interface TodaySummary {
  statusCounts: Record<string, number>;
  shippedToday: number;
  cancelledToday: number;
  ordersPickedToday: number;
  unitsPickedToday: number;
  ordersPackedToday: number;
  unitsPackedToday: number;
  blockedOrders: number;
  blockedUnits: number;
  openExceptions: number;
  generatedAt: string;
}

/**
 * The warehouse-wide "how's today going" snapshot — every role can see it
 * (unlike the rest of /admin), since a packer asking "are we behind" or "is
 * anything stuck" needs the same picture an admin does, not a scoped-down
 * one. Two different kinds of number on purpose: `statusCounts` is a live
 * snapshot (this *is* today's picture in a same-day pick/pack/ship
 * operation — see HANDOFF.md's Easy Ship cutoff), while shipped/cancelled/
 * picked/packed are real calendar-day activity counts, since those are
 * events that happened *on* a day, not a status an order sits in.
 */
export async function getTodaySummary(db: D1Database, warehouseId: string): Promise<TodaySummary> {
  const statusRows = await db
    .prepare(`SELECT status, COUNT(*) as c FROM orders WHERE warehouse_id = ? GROUP BY status`)
    .bind(warehouseId)
    .all<{ status: string; c: number }>();
  const statusCounts: Record<string, number> = Object.fromEntries(ORDER_STATUSES.map((s) => [s, 0]));
  for (const row of statusRows.results) {
    if (row.status in statusCounts) statusCounts[row.status] = row.c;
  }

  const shippedToday = await db
    .prepare(
      `SELECT COUNT(*) as c FROM audit_log WHERE action = 'order.shipped_sync' AND entity_id IN (SELECT id FROM orders WHERE warehouse_id = ?) AND date(created_at) = date('now')`
    )
    .bind(warehouseId)
    .first<{ c: number }>();

  const cancelledToday = await db
    .prepare(
      `SELECT COUNT(*) as c FROM audit_log WHERE action = 'order.cancelled_sync' AND entity_id IN (SELECT id FROM orders WHERE warehouse_id = ?) AND date(created_at) = date('now')`
    )
    .bind(warehouseId)
    .first<{ c: number }>();

  const pickedToday = await db
    .prepare(
      `SELECT COUNT(DISTINCT oi.order_id) as orders, COALESCE(SUM(pt.quantity_picked), 0) as units
       FROM pick_tasks pt
       JOIN order_items oi ON oi.id = pt.order_item_id
       JOIN orders o ON o.id = oi.order_id
       WHERE o.warehouse_id = ? AND pt.status IN ('picked', 'short') AND date(pt.picked_at) = date('now')`
    )
    .bind(warehouseId)
    .first<{ orders: number; units: number }>();

  const packedToday = await db
    .prepare(
      `SELECT ps.order_id,
              (SELECT COALESCE(SUM(oi.quantity_packed), 0) FROM order_items oi WHERE oi.order_id = ps.order_id) AS units_packed
       FROM pack_sessions ps
       JOIN orders o ON o.id = ps.order_id
       WHERE o.warehouse_id = ? AND ps.status IN ('completed', 'partial') AND date(ps.completed_at) = date('now')`
    )
    .bind(warehouseId)
    .all<{ order_id: string; units_packed: number }>();

  const openExceptions = await db
    .prepare(
      `SELECT COUNT(*) as c
       FROM exception_events ee
       LEFT JOIN orders o1 ON o1.id = ee.order_id
       LEFT JOIN pick_tasks pt ON pt.id = ee.pick_task_id
       LEFT JOIN order_items oi ON oi.id = pt.order_item_id
       LEFT JOIN orders o2 ON o2.id = oi.order_id
       LEFT JOIN pack_sessions ps ON ps.id = ee.pack_session_id
       LEFT JOIN orders o3 ON o3.id = ps.order_id
       WHERE ee.resolved = 0
         AND (COALESCE(o1.warehouse_id, o2.warehouse_id, o3.warehouse_id) = ? OR (o1.id IS NULL AND o2.id IS NULL AND o3.id IS NULL))`
    )
    .bind(warehouseId)
    .first<{ c: number }>();

  const blocked = await getUnbatchedOrderSummary(db, warehouseId);

  return {
    statusCounts,
    shippedToday: shippedToday?.c ?? 0,
    cancelledToday: cancelledToday?.c ?? 0,
    ordersPickedToday: pickedToday?.orders ?? 0,
    unitsPickedToday: pickedToday?.units ?? 0,
    ordersPackedToday: packedToday.results.length,
    unitsPackedToday: packedToday.results.reduce((sum, r) => sum + r.units_packed, 0),
    blockedOrders: blocked.orderCount,
    blockedUnits: blocked.unitCount,
    openExceptions: openExceptions?.c ?? 0,
    generatedAt: new Date().toISOString()
  };
}
