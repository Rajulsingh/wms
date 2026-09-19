import { newId, logAudit, logException } from './db';

export class PackerFlowError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

// Field names match the SQL aliases exactly (snake_case) — D1 doesn't
// camelCase rows, so the interface has to match what actually comes back,
// not what would be conventional in TS. A mismatch here type-checks fine
// but silently breaks every comparison at runtime (found the hard way).
export interface PackItemView {
  order_item_id: string;
  sku_code: string;
  sku_name: string;
  image_url: string | null;
  quantity_required: number; // = quantity_picked from picking, what's actually in the cart for this order
  quantity_packed: number;
}

export interface PackSessionState {
  packSessionId: string;
  orderId: string;
  status: string;
  items: PackItemView[];
  allPacked: boolean;
}

export interface PackBatchItemView {
  order_item_id: string;
  order_id: string;
  external_order_id: string;
  order_notes: string | null;
  sku_code: string;
  sku_name: string;
  image_url: string | null;
  quantity_required: number;
  quantity_packed: number;
}

export interface PackBatchOrderSummary {
  orderId: string;
  externalOrderId: string;
  packSessionId: string;
  allPacked: boolean;
  notes: string | null;
}

export interface PackBatchState {
  pickBatchId: string;
  items: PackBatchItemView[];
  orders: PackBatchOrderSummary[];
  allPacked: boolean;
}

/** Every pick_batch this packer currently has open (as pack_sessions) at this station, oldest first. */
export async function getMyActivePackBatchIds(db: D1Database, stationId: string, packerId: string): Promise<string[]> {
  const rows = await db
    .prepare(
      `SELECT DISTINCT pick_batch_id, MIN(started_at) AS started_at FROM pack_sessions
       WHERE station_id = ? AND packer_id = ? AND status = 'in_progress' AND pick_batch_id IS NOT NULL
       GROUP BY pick_batch_id
       ORDER BY started_at ASC`
    )
    .bind(stationId, packerId)
    .all<{ pick_batch_id: string }>();
  return rows.results.map((r) => r.pick_batch_id);
}

/**
 * Claims the oldest fully-picked *batch* waiting at this warehouse that
 * nobody's packing yet — one `pack_sessions` row per order in that batch,
 * all created together and tagged with the same `pick_batch_id` (migration
 * 0010), so the packer works through every order (SKU-grouped, same
 * pattern as picking) before any label goes on. Every order in a
 * pick_batch reaches 'picked' atomically together (picker.ts's
 * checkBatchCompletion sets them all at once), so "every order sharing a
 * pick_batch_id" is always a coherent, complete unit of packing work —
 * never a partial one. Returns null if nothing's waiting. See HANDOFF.md.
 */
async function claimNextPackBatch(db: D1Database, userId: string, stationId: string, warehouseId: string): Promise<string | null> {
  const candidate = await db
    .prepare(
      `SELECT pt.pick_batch_id AS id, MIN(pb.completed_at) AS completed_at
       FROM pick_tasks pt
       JOIN pick_batches pb ON pb.id = pt.pick_batch_id
       JOIN order_items oi ON oi.id = pt.order_item_id
       JOIN orders o ON o.id = oi.order_id
       WHERE o.warehouse_id = ? AND o.status = 'picked'
         AND pt.pick_batch_id NOT IN (SELECT DISTINCT pick_batch_id FROM pack_sessions WHERE pick_batch_id IS NOT NULL)
       GROUP BY pt.pick_batch_id
       ORDER BY completed_at ASC
       LIMIT 1`
    )
    .bind(warehouseId)
    .first<{ id: string }>();
  if (!candidate) return null;

  const orders = await db
    .prepare(
      `SELECT DISTINCT o.id
       FROM pick_tasks pt JOIN order_items oi ON oi.id = pt.order_item_id JOIN orders o ON o.id = oi.order_id
       WHERE pt.pick_batch_id = ?`
    )
    .bind(candidate.id)
    .all<{ id: string }>();

  for (const order of orders.results) {
    const sessionId = newId();
    await db
      .prepare(`INSERT INTO pack_sessions (id, order_id, packer_id, station_id, pick_batch_id, status) VALUES (?, ?, ?, ?, ?, 'in_progress')`)
      .bind(sessionId, order.id, userId, stationId, candidate.id)
      .run();
    await db.prepare(`UPDATE orders SET status = 'packing' WHERE id = ?`).bind(order.id).run();
  }
  await logAudit(db, { userId, action: 'pack.batch_start', entityType: 'pick_batch', entityId: candidate.id, metadata: { orderCount: orders.results.length } });

  return candidate.id;
}

export interface MyPackBatches {
  stationId: string;
  batches: PackBatchState[];
}

/**
 * Verifies the station QR/barcode (packing-station equivalent of the rack
 * check, §4/§8), then returns every batch this packer currently has open at
 * this station, plus a sweep for anything freshly ready. The packer page
 * renders all of them on one continuous page (no "get next batch" click
 * gate) and reuses this same call for its 8s poll — so the sweep below runs
 * on every poll, not just when the packer has zero batches, otherwise a
 * batch that finishes picking mid-walk would sit invisible until everything
 * already open got packed first. claimNextPackBatch already excludes
 * batches this or any packer already has a pack_session for, so looping it
 * here is safe to call every tick — it naturally stops once nothing new is
 * ready. See HANDOFF.md.
 */
export async function getMyPackBatches(db: D1Database, userId: string, stationQrToken: string, warehouseId: string): Promise<MyPackBatches> {
  const station = await db.prepare(`SELECT id FROM packing_stations WHERE qr_token = ? AND warehouse_id = ?`).bind(stationQrToken, warehouseId).first<{ id: string }>();
  if (!station) throw new PackerFlowError('unknown_station', 'This station QR code is not recognized');

  const batchIds = await getMyActivePackBatchIds(db, station.id, userId);
  for (;;) {
    const claimed = await claimNextPackBatch(db, userId, station.id, warehouseId);
    if (!claimed) break;
    batchIds.push(claimed);
  }

  const batches: PackBatchState[] = [];
  for (const id of batchIds) batches.push(await getPackBatchState(db, id));
  return { stationId: station.id, batches };
}

export async function getPackBatchState(db: D1Database, pickBatchId: string): Promise<PackBatchState> {
  const sessions = await db
    .prepare(`SELECT id, order_id, status FROM pack_sessions WHERE pick_batch_id = ?`)
    .bind(pickBatchId)
    .all<{ id: string; order_id: string; status: string }>();
  if (!sessions.results.length) throw new PackerFlowError('not_found', 'No pack sessions for this batch');

  const orderIds = sessions.results.map((s) => s.order_id);
  const placeholders = orderIds.map(() => '?').join(',');

  // Fetched separately from `items` below — an order whose items are *all*
  // short/damaged from picking (nothing left with status 'picked'/'packed')
  // legitimately has zero rows there, and deriving externalOrderId from
  // that query left it blank for exactly that edge case. Orders are the
  // source of truth for their own external id regardless of item status.
  const orderRows = await db
    .prepare(`SELECT id, external_order_id, notes FROM orders WHERE id IN (${placeholders})`)
    .bind(...orderIds)
    .all<{ id: string; external_order_id: string; notes: string | null }>();
  const externalIdByOrder = new Map(orderRows.results.map((o) => [o.id, o.external_order_id]));
  const notesByOrder = new Map(orderRows.results.map((o) => [o.id, o.notes]));

  // 'short' is included alongside 'picked'/'packed' as long as some units
  // were actually picked (quantity_picked > 0) — a partial short pick still
  // has real, physical units that need to go in a box. A 'short' item with
  // quantity_picked = 0 has nothing to pack at all and stays excluded (the
  // "nothing to pack, every item came back short/damaged" edge case below
  // still applies to those). Previously this only matched 'picked'/'packed',
  // so a partial short pick's physically-picked units silently never
  // appeared anywhere in the packing UI — found 2026-09-19, see HANDOFF.md.
  const items = await db
    .prepare(
      `SELECT oi.id AS order_item_id, oi.order_id, o.external_order_id, o.notes AS order_notes, sk.sku_code, sk.name AS sku_name, sk.image_url,
              oi.quantity_picked AS quantity_required, oi.quantity_packed
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       JOIN skus sk ON sk.id = oi.sku_id
       WHERE oi.order_id IN (${placeholders})
         AND (oi.status IN ('picked', 'packed') OR (oi.status = 'short' AND oi.quantity_picked > 0))
       ORDER BY sk.sku_code ASC`
    )
    .bind(...orderIds)
    .all<PackBatchItemView>();

  const packedByOrder = new Map<string, boolean>();
  for (const oid of orderIds) packedByOrder.set(oid, true);
  for (const it of items.results) {
    if (it.quantity_packed < it.quantity_required) packedByOrder.set(it.order_id, false);
  }

  const orders: PackBatchOrderSummary[] = sessions.results.map((s) => ({
    orderId: s.order_id,
    externalOrderId: externalIdByOrder.get(s.order_id) ?? '',
    packSessionId: s.id,
    allPacked: packedByOrder.get(s.order_id) ?? true,
    notes: notesByOrder.get(s.order_id) ?? null
  }));

  return {
    pickBatchId,
    items: items.results,
    orders,
    allPacked: orders.every((o) => o.allPacked)
  };
}

export interface PackLineInput {
  orderItemId: string;
  quantity: number;
}

/**
 * Bulk pack confirm for one order — every SKU line on that order at once, in
 * a single tap, each with its own quantity (no pooling: unlike picking,
 * where the same SKU genuinely is one shared physical pile across orders,
 * an order's own SKU lines are independent boxes going into the same
 * package, so there's nothing to pool). No reservation/short-pick concept
 * here (that already happened at picking) — packing just records what
 * physically went into the box, capped at what picking actually delivered.
 */
export async function markPackOrder(db: D1Database, userId: string, pickBatchId: string, orderId: string, lines: PackLineInput[]): Promise<PackBatchState> {
  if (!lines.length) throw new PackerFlowError('not_found', 'No items given');

  for (const line of lines) {
    const item = await db
      .prepare(`SELECT quantity_picked AS required FROM order_items WHERE id = ? AND order_id = ?`)
      .bind(line.orderItemId, orderId)
      .first<{ required: number }>();
    if (!item) throw new PackerFlowError('not_found', 'Order item not found on this order');
    if (line.quantity < 0 || line.quantity > item.required) {
      throw new PackerFlowError('bad_quantity', `Quantity must be between 0 and ${item.required}`);
    }
    await db.prepare(`UPDATE order_items SET quantity_packed = ? WHERE id = ?`).bind(line.quantity, line.orderItemId).run();
  }
  await logAudit(db, { userId, action: 'pack.mark_order', entityType: 'order', entityId: orderId, metadata: { lines } });

  return getPackBatchState(db, pickBatchId);
}

/**
 * Completes packing for every order in the batch at once — reuses the same
 * per-order completion (`completePackSession`, unchanged) the old
 * one-order-at-a-time flow always used, just looped across the whole
 * batch. Every order must already be fully packed (checked via
 * `getPackBatchState`) before this succeeds, matching "the whole pick list
 * is done" before any label goes on.
 */
export async function completePackingBatch(db: D1Database, userId: string, pickBatchId: string): Promise<Array<{ orderId: string; packSessionId: string; outcome: 'completed' | 'partial' }>> {
  const state = await getPackBatchState(db, pickBatchId);
  if (!state.allPacked) throw new PackerFlowError('items_missing', 'Not everything has been marked packed yet');

  const results: Array<{ orderId: string; packSessionId: string; outcome: 'completed' | 'partial' }> = [];
  for (const order of state.orders) {
    const outcome = await completePackSession(db, userId, order.packSessionId);
    results.push({ orderId: order.orderId, packSessionId: order.packSessionId, outcome });
  }
  return results;
}

export async function getPackSessionState(db: D1Database, packSessionId: string): Promise<PackSessionState> {
  const session = await db.prepare(`SELECT * FROM pack_sessions WHERE id = ?`).bind(packSessionId).first<{ id: string; order_id: string; status: string }>();
  if (!session) throw new PackerFlowError('not_found', 'Pack session not found');

  // Same fix as getPackBatchState's items query above — a partial short
  // pick (status 'short', quantity_picked > 0) still has real units to pack.
  const items = await db
    .prepare(
      `SELECT oi.id as order_item_id, sk.sku_code, sk.name as sku_name, sk.image_url, oi.quantity_picked as quantity_required, oi.quantity_packed
       FROM order_items oi JOIN skus sk ON sk.id = oi.sku_id
       WHERE oi.order_id = ? AND (oi.status IN ('picked', 'packed') OR (oi.status = 'short' AND oi.quantity_picked > 0))`
    )
    .bind(session.order_id)
    .all<PackItemView>();

  const allPacked = items.results.every((i) => i.quantity_packed >= i.quantity_required);
  return { packSessionId: session.id, orderId: session.order_id, status: session.status, items: items.results, allPacked };
}

/** Completes packing. Items that were short/damaged during picking don't block this — the order just ships partial (§6). */
export async function completePackSession(db: D1Database, userId: string, packSessionId: string): Promise<'completed' | 'partial'> {
  const state = await getPackSessionState(db, packSessionId);
  if (!state.allPacked) throw new PackerFlowError('items_missing', 'Not everything has been marked packed yet');

  const shortItems = await db
    .prepare(`SELECT COUNT(*) as c FROM order_items WHERE order_id = ? AND status = 'short'`)
    .bind(state.orderId)
    .first<{ c: number }>();
  const outcome: 'completed' | 'partial' = (shortItems?.c ?? 0) > 0 ? 'partial' : 'completed';

  await db.prepare(`UPDATE pack_sessions SET status = ?, completed_at = datetime('now') WHERE id = ?`).bind(outcome, packSessionId).run();
  await db.prepare(`UPDATE order_items SET status = 'packed' WHERE order_id = ? AND status = 'picked'`).bind(state.orderId).run();
  await db.prepare(`UPDATE orders SET status = ? WHERE id = ?`).bind(outcome === 'partial' ? 'partial' : 'packed', state.orderId).run();
  await logAudit(db, { userId, action: 'pack.session_complete', entityType: 'order', entityId: state.orderId, metadata: { outcome } });

  return outcome;
}

export interface PendingLabelOrder {
  orderId: string;
  externalOrderId: string;
  packSessionId: string;
  notes: string | null;
}

/**
 * Orders this packer has already marked packed (`pack_sessions` status
 * `completed`/`partial`) but hasn't scanned an AWB for yet — the mandatory
 * next step, still outstanding. Needed because completing a pack session
 * moves the order's status past `'picked'`, out of `getMyPackBatches`'
 * own query entirely — without this, a packer who navigates away (or the
 * page reloads) mid-labeling would lose every trace of which orders still
 * need a label: stuck, with no way back to finish them, since the normal
 * packing list no longer has anywhere to show them.
 *
 * Checked on every tap-in/poll (`start-session.ts`) and always takes
 * precedence over the normal packing list client-side, so labeling can't
 * be skipped just by leaving the page and coming back. Scoped to this
 * packer's own pack_sessions, same ownership model as everything else here.
 * "Not yet labeled" = no `packages` row references this pack_session yet —
 * that's exactly what `applyAwb` sets the moment a label is actually
 * applied, whether matching a pre-purchased label or creating a fresh one.
 */
export async function getPendingLabelQueue(db: D1Database, packerId: string): Promise<PendingLabelOrder[]> {
  const rows = await db
    .prepare(
      `SELECT ps.id AS pack_session_id, ps.order_id, o.external_order_id, o.notes
       FROM pack_sessions ps
       JOIN orders o ON o.id = ps.order_id
       WHERE ps.packer_id = ? AND ps.status IN ('completed', 'partial')
         AND NOT EXISTS (SELECT 1 FROM packages p WHERE p.pack_session_id = ps.id)
       ORDER BY ps.completed_at ASC`
    )
    .bind(packerId)
    .all<{ pack_session_id: string; order_id: string; external_order_id: string; notes: string | null }>();

  return rows.results.map((r) => ({
    orderId: r.order_id,
    externalOrderId: r.external_order_id,
    packSessionId: r.pack_session_id,
    notes: r.notes
  }));
}

export interface PackerDailyOrder {
  orderId: string;
  externalOrderId: string;
  outcome: 'completed' | 'partial';
  completedAt: string;
  unitsPacked: number;
}

export interface PackerDailySummary {
  orderCount: number;
  unitsPacked: number;
  orders: PackerDailyOrder[];
}

/**
 * What this packer has actually finished packing today, newest first — "so
 * they know what they have done" instead of a dashboard that only ever
 * shows work still waiting. `date(completed_at) = date('now')` scopes to
 * the server's calendar day, same as any other "today" summary here would.
 */
export async function getPackerDailySummary(db: D1Database, warehouseId: string, packerId: string): Promise<PackerDailySummary> {
  const rows = await db
    .prepare(
      `SELECT ps.order_id, o.external_order_id, ps.status, ps.completed_at,
              (SELECT COALESCE(SUM(oi.quantity_packed), 0) FROM order_items oi WHERE oi.order_id = ps.order_id) AS units_packed
       FROM pack_sessions ps JOIN orders o ON o.id = ps.order_id
       WHERE ps.packer_id = ? AND o.warehouse_id = ? AND ps.status IN ('completed', 'partial')
         AND date(ps.completed_at) = date('now')
       ORDER BY ps.completed_at DESC`
    )
    .bind(packerId, warehouseId)
    .all<{ order_id: string; external_order_id: string; status: 'completed' | 'partial'; completed_at: string; units_packed: number }>();

  const orders: PackerDailyOrder[] = rows.results.map((r) => ({
    orderId: r.order_id,
    externalOrderId: r.external_order_id,
    outcome: r.status,
    completedAt: r.completed_at,
    unitsPacked: r.units_packed
  }));

  return { orderCount: orders.length, unitsPacked: orders.reduce((sum, o) => sum + o.unitsPacked, 0), orders };
}

export interface AwbResult {
  shipmentId: string;
  awbCode: string;
}

/**
 * Hard-blocks on a duplicate/mismatched AWB or a session that isn't
 * actually pack-complete — exactly the safeguard from the original spec (§6).
 *
 * Two paths: if admin already purchased a real Amazon shipping label for
 * this order (via the Merchant Fulfillment API, before packing started —
 * see §"admin picks box size" flow), a package/shipment/awb row already
 * exists with `pack_session_id` still NULL. The packer's scan here just has
 * to MATCH that pre-existing tracking id and link it to this pack session —
 * never create a second one. Orders without a pre-purchased label (manual/
 * CSV orders) fall back to the original create-on-scan behavior.
 */
export async function applyAwb(db: D1Database, userId: string, packSessionId: string, awbCode: string): Promise<AwbResult> {
  const session = await db.prepare(`SELECT * FROM pack_sessions WHERE id = ?`).bind(packSessionId).first<{ id: string; order_id: string; status: string }>();
  if (!session) throw new PackerFlowError('not_found', 'Pack session not found');
  if (session.status !== 'completed' && session.status !== 'partial') {
    throw new PackerFlowError('not_packed', 'This order is not marked packed yet — cannot apply a label');
  }

  const existing = await db
    .prepare(
      `SELECT p.id as package_id, s.id as shipment_id, s.tracking_id
       FROM packages p JOIN shipments s ON s.package_id = p.id
       WHERE p.order_id = ? AND p.pack_session_id IS NULL
       ORDER BY p.created_at DESC LIMIT 1`
    )
    .bind(session.order_id)
    .first<{ package_id: string; shipment_id: string; tracking_id: string | null }>();

  if (existing) {
    if (existing.tracking_id && existing.tracking_id !== awbCode) {
      await logException(db, { type: 'awb_mismatch', orderId: session.order_id, packSessionId, userId, notes: `Scanned "${awbCode}", expected the pre-purchased label's tracking id` });
      throw new PackerFlowError('awb_mismatch', 'This AWB does not match the label already purchased for this order.');
    }
    await db.prepare(`UPDATE packages SET pack_session_id = ?, status = 'labeled' WHERE id = ?`).bind(packSessionId, existing.package_id).run();
    await db.prepare(`UPDATE shipments SET status = 'ready_to_ship' WHERE id = ?`).bind(existing.shipment_id).run();
    await db.prepare(`UPDATE orders SET status = 'ready_to_ship' WHERE id = ? AND status IN ('packed', 'partial')`).bind(session.order_id).run();
    await logAudit(db, { userId, action: 'scan.awb', entityType: 'shipment', entityId: existing.shipment_id, metadata: { awbCode, prePurchased: true } });
    return { shipmentId: existing.shipment_id, awbCode };
  }

  const dupe = await db.prepare(`SELECT id FROM awbs WHERE awb_code = ?`).bind(awbCode).first<{ id: string }>();
  if (dupe) {
    await logException(db, { type: 'duplicate_awb', orderId: session.order_id, packSessionId, userId, notes: `AWB ${awbCode} already applied to another package` });
    throw new PackerFlowError('duplicate_awb', 'This AWB has already been used on another package. Cannot mark ready to ship.');
  }

  const packageId = newId();
  await db.prepare(`INSERT INTO packages (id, order_id, pack_session_id, status) VALUES (?, ?, ?, 'labeled')`).bind(packageId, session.order_id, packSessionId).run();

  const shipmentId = newId();
  await db.prepare(`INSERT INTO shipments (id, package_id, status) VALUES (?, ?, 'ready_to_ship')`).bind(shipmentId, packageId).run();

  await db
    .prepare(`INSERT INTO awbs (id, shipment_id, awb_code, scanned_at, verified) VALUES (?, ?, ?, datetime('now'), 1)`)
    .bind(newId(), shipmentId, awbCode)
    .run();

  await db.prepare(`UPDATE orders SET status = 'ready_to_ship' WHERE id = ? AND status IN ('packed', 'partial')`).bind(session.order_id).run();
  await logAudit(db, { userId, action: 'scan.awb', entityType: 'shipment', entityId: shipmentId, metadata: { awbCode } });

  return { shipmentId, awbCode };
}
