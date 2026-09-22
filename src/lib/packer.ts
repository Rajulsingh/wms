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
  msku: string | null;
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
 *
 * The "is it unclaimed" check and the inserts below used to be two separate
 * round-trips with nothing locking the gap — the packer page's SSR load and
 * its own 8s client poll (or two open tabs) could both pass the check
 * before either had inserted, each creating a full duplicate set of
 * pack_sessions for the same batch. That shipped a real bug: the same
 * order appeared twice in the packer UI, one copy oblivious to packed
 * quantity the other had recorded — see migration 0035, which also added a
 * UNIQUE(pick_batch_id, order_id) index as a hard backstop. The insert loop
 * now runs as one db.batch() (atomic, same pattern lib/org-accounts.ts
 * uses): either every order's session is created or none are, and if a
 * concurrent request already won the race, the UNIQUE violation throws,
 * which is treated as "already claimed" rather than a real error.
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

  const statements = orders.results.flatMap((order) => {
    const sessionId = newId();
    return [
      db.prepare(`INSERT INTO pack_sessions (id, order_id, packer_id, station_id, pick_batch_id, status) VALUES (?, ?, ?, ?, ?, 'in_progress')`).bind(sessionId, order.id, userId, stationId, candidate.id),
      db.prepare(`UPDATE orders SET status = 'packing' WHERE id = ?`).bind(order.id)
    ];
  });

  try {
    await db.batch(statements);
  } catch {
    // Someone else's claim landed first between our check above and this
    // batch — not a real failure, just a lost race. Next poll will see the
    // batch already claimed and move on to the next candidate.
    return null;
  }
  await logAudit(db, { userId, action: 'pack.batch_start', entityType: 'pick_batch', entityId: candidate.id, metadata: { orderCount: orders.results.length } });

  return candidate.id;
}

export interface MyPackBatches {
  stationId: string;
  batches: PackBatchState[];
}

/**
 * Returns every batch this packer currently has open at their assigned
 * station, plus a sweep for anything freshly ready. `stationId` comes from
 * the packer's own account (`users.station_id`, assigned once by admin in
 * Users) rather than a scanned QR code every session — station is now
 * purely a fixed property of who's logged in, kept for reports/reference on
 * `pack_sessions`, not a step a packer walks through. The packer page
 * renders all batches on one continuous page (no "get next batch" click
 * gate) and reuses this same call for its 8s poll — so the sweep below runs
 * on every poll, not just when the packer has zero batches, otherwise a
 * batch that finishes picking mid-walk would sit invisible until everything
 * already open got packed first. claimNextPackBatch already excludes
 * batches this or any packer already has a pack_session for, so looping it
 * here is safe to call every tick — it naturally stops once nothing new is
 * ready. See HANDOFF.md.
 */
export async function getMyPackBatches(db: D1Database, userId: string, stationId: string, warehouseId: string): Promise<MyPackBatches> {
  const batchIds = await getMyActivePackBatchIds(db, stationId, userId);
  for (;;) {
    const claimed = await claimNextPackBatch(db, userId, stationId, warehouseId);
    if (!claimed) break;
    batchIds.push(claimed);
  }

  const batches: PackBatchState[] = [];
  for (const id of batchIds) batches.push(await getPackBatchState(db, id));
  return { stationId, batches };
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
      `SELECT oi.id AS order_item_id, oi.order_id, o.external_order_id, o.notes AS order_notes, sk.sku_code, sk.name AS sku_name, sk.msku, sk.image_url,
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
  completedAt: string;
  imageUrl: string | null;
  skuSummary: string;
  unitCount: number;
}

/**
 * Orders that have been marked packed (`pack_sessions` status
 * `completed`/`partial`) but haven't been scanned/labeled yet — warehouse-
 * wide, not scoped to whichever packer happens to be looking (the scan
 * station is a shared, later step; any packer can pick up any box). Oldest
 * first, since scanning is pure FIFO — see `applyAwbByScan` below. "Not yet
 * labeled" = no `packages` row references this pack_session yet, which is
 * exactly what a scan sets the moment it's applied, whether linking a
 * pre-purchased label or creating a fresh one.
 *
 * Excludes `o.status = 'cancelled'` — amazon-sync.ts's cancelOrderFromSync
 * deliberately leaves an already-packed order's pack_session/items alone
 * (see its docstring: no way to know which physical unit is where, so it
 * logs an exception for a human instead of touching inventory). Without
 * this filter, a box Amazon cancelled after packing but before scanning
 * would still show up here as ready to label and ship — a real shipping
 * risk, not just a display glitch (found live: order 404-6655591-3241911
 * showed cancelled but still appeared packed/ready in the packer UI).
 */
export async function getPendingLabels(db: D1Database, warehouseId: string): Promise<PendingLabelOrder[]> {
  const rows = await db
    .prepare(
      `SELECT ps.id AS pack_session_id, ps.order_id, ps.completed_at, o.external_order_id, o.notes,
              (SELECT sk.image_url FROM order_items oi JOIN skus sk ON sk.id = oi.sku_id WHERE oi.order_id = ps.order_id ORDER BY oi.id LIMIT 1) AS image_url,
              (SELECT sk.sku_code FROM order_items oi JOIN skus sk ON sk.id = oi.sku_id WHERE oi.order_id = ps.order_id ORDER BY oi.id LIMIT 1) AS first_sku_code,
              (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = ps.order_id) AS item_count,
              (SELECT COALESCE(SUM(oi.quantity_packed), 0) FROM order_items oi WHERE oi.order_id = ps.order_id) AS unit_count
       FROM pack_sessions ps
       JOIN orders o ON o.id = ps.order_id
       WHERE o.warehouse_id = ? AND ps.status IN ('completed', 'partial') AND o.status != 'cancelled'
         AND NOT EXISTS (SELECT 1 FROM packages p WHERE p.pack_session_id = ps.id)
       ORDER BY ps.completed_at ASC`
    )
    .bind(warehouseId)
    .all<{
      pack_session_id: string;
      order_id: string;
      completed_at: string;
      external_order_id: string;
      notes: string | null;
      image_url: string | null;
      first_sku_code: string | null;
      item_count: number;
      unit_count: number;
    }>();

  return rows.results.map((r) => ({
    orderId: r.order_id,
    externalOrderId: r.external_order_id,
    packSessionId: r.pack_session_id,
    notes: r.notes,
    completedAt: r.completed_at,
    imageUrl: r.image_url,
    skuSummary: r.item_count > 1 ? `${r.first_sku_code ?? '—'} +${r.item_count - 1} more` : (r.first_sku_code ?? '—'),
    unitCount: r.unit_count
  }));
}

export interface PackerDailyOrder {
  orderId: string;
  externalOrderId: string;
  outcome: 'completed' | 'partial';
  completedAt: string;
  unitsPacked: number;
  imageUrl: string | null;
}

export interface PackerDailySummary {
  orderCount: number;
  unitsPacked: number;
  orders: PackerDailyOrder[];
}

/**
 * What this packer has actually finished packing today, newest first — "so
 * they know what they have done" instead of a dashboard that only ever
 * shows work still waiting. Scoped to the server's calendar day via a plain
 * range on `completed_at` rather than `date(completed_at) = date('now')` —
 * the latter wraps the column in a function, which defeats any index on it
 * (see dashboard.ts's getTodaySummary for the full story — the same pattern
 * there was reading several million rows/day off a growing table). This
 * endpoint is polled every 15s by every packer's dashboard, so keeping it
 * indexable matters here too even though pack_sessions is small today.
 *
 * Excludes `o.status = 'cancelled'` — same reasoning as getPendingLabels
 * above: Amazon can cancel an order after it's already been packed, and
 * cancelOrderFromSync (amazon-sync.ts) deliberately doesn't touch the
 * pack_session for that. Without this filter a cancelled order kept
 * showing here as if it were a normal completed pack, contradicting its
 * own "cancelled" status shown elsewhere (found live: 404-6655591-3241911).
 */
export async function getPackerDailySummary(db: D1Database, warehouseId: string, packerId: string): Promise<PackerDailySummary> {
  const rows = await db
    .prepare(
      `SELECT ps.order_id, o.external_order_id, ps.status, ps.completed_at,
              (SELECT COALESCE(SUM(oi.quantity_packed), 0) FROM order_items oi WHERE oi.order_id = ps.order_id) AS units_packed,
              (SELECT sk.image_url FROM order_items oi JOIN skus sk ON sk.id = oi.sku_id WHERE oi.order_id = ps.order_id ORDER BY oi.id LIMIT 1) AS image_url
       FROM pack_sessions ps JOIN orders o ON o.id = ps.order_id
       WHERE ps.packer_id = ? AND o.warehouse_id = ? AND ps.status IN ('completed', 'partial') AND o.status != 'cancelled'
         AND ps.completed_at >= date('now') AND ps.completed_at < date('now', '+1 day')
       ORDER BY ps.completed_at DESC`
    )
    .bind(packerId, warehouseId)
    .all<{ order_id: string; external_order_id: string; status: 'completed' | 'partial'; completed_at: string; units_packed: number; image_url: string | null }>();

  const orders: PackerDailyOrder[] = rows.results.map((r) => ({
    orderId: r.order_id,
    externalOrderId: r.external_order_id,
    outcome: r.status,
    completedAt: r.completed_at,
    unitsPacked: r.units_packed,
    imageUrl: r.image_url
  }));

  return { orderCount: orders.length, unitsPacked: orders.reduce((sum, o) => sum + o.unitsPacked, 0), orders };
}

export interface AwbResult {
  shipmentId: string;
  awbCode: string;
}

export interface ScanResult extends AwbResult {
  orderId: string;
  externalOrderId: string;
  skuSummary: string;
  unitCount: number;
}

/**
 * Matched by real AWB data first, FIFO only as a fallback. Amazon (both
 * `purchaseLabelForOrder` and `scheduleEasyShipForOrder`/`scheduleEasyShipBulk`
 * in shipping.ts) already tells this system exactly which order a tracking
 * id/AWB belongs to the moment a label is purchased or scheduled — well
 * before anyone packs the box, let alone scans it — and inserts that code
 * into `awbs` right then. A packer's later physical scan of the exact same
 * code printed on that label is therefore not a guess: this looks the code
 * up first, and if Amazon already told us its real order, that's what it's
 * applied to, regardless of which order happens to be oldest in the pending
 * pool. FIFO (`getPendingLabels`, warehouse-wide — any packer's completed
 * order) only kicks in for a code this system has no other way to identify
 * (a manual/external courier label with no Amazon-side record) — same
 * "just for record keeping" behavior as before for that case. See
 * `applyAwb(packSessionId, awbCode)`, the older pre-select-and-compare flow
 * this replaced (HANDOFF.md) — that verification step is intentionally not
 * coming back; this is a real lookup against data the system already has,
 * not a re-introduced "does it match what we expected" check.
 */
export async function applyAwbByScan(db: D1Database, userId: string, warehouseId: string, awbCode: string): Promise<ScanResult> {
  // A package's pack_session_id is NULL only between the moment a label is
  // purchased/scheduled and the moment some scan (this function, on a first
  // or later call) resolves it — a reliable "known, real link, not yet
  // confirmed on the floor" signal. Non-NULL means this exact code already
  // went through this resolution once before — a genuine duplicate, not a
  // pre-purchased label waiting for its first scan.
  const known = await db
    .prepare(
      `SELECT p.id as package_id, p.order_id, p.pack_session_id, s.id as shipment_id
       FROM awbs a JOIN shipments s ON s.id = a.shipment_id JOIN packages p ON p.id = s.package_id
       WHERE a.awb_code = ?`
    )
    .bind(awbCode)
    .first<{ package_id: string; order_id: string; pack_session_id: string | null; shipment_id: string }>();

  if (known && known.pack_session_id !== null) {
    await logException(db, { type: 'duplicate_awb', orderId: known.order_id, userId, notes: `AWB ${awbCode} already applied to another order` });
    throw new PackerFlowError('duplicate_awb', 'This AWB has already been scanned for another order.');
  }

  const pending = await getPendingLabels(db, warehouseId);

  let target: PendingLabelOrder | undefined;
  if (known) {
    // This code is definitively for known.order_id — find its own entry in
    // the pending pool rather than trusting FIFO position at all.
    target = pending.find((p) => p.orderId === known.order_id);
    if (!target) {
      const order = await db.prepare(`SELECT external_order_id FROM orders WHERE id = ?`).bind(known.order_id).first<{ external_order_id: string }>();
      throw new PackerFlowError(
        'not_ready',
        `This AWB belongs to order ${order?.external_order_id ?? known.order_id}, but it hasn't finished packing yet — pack it first, then scan.`
      );
    }
  } else {
    target = pending[0];
  }
  if (!target) throw new PackerFlowError('nothing_pending', 'Nothing is waiting to be scanned right now.');

  let shipmentId: string;
  if (known) {
    await db.prepare(`UPDATE packages SET pack_session_id = ?, status = 'labeled' WHERE id = ?`).bind(target.packSessionId, known.package_id).run();
    await db.prepare(`UPDATE shipments SET status = 'ready_to_ship' WHERE id = ?`).bind(known.shipment_id).run();
    shipmentId = known.shipment_id;
  } else {
    const packageId = newId();
    await db.prepare(`INSERT INTO packages (id, order_id, pack_session_id, status) VALUES (?, ?, ?, 'labeled')`).bind(packageId, target.orderId, target.packSessionId).run();
    shipmentId = newId();
    await db.prepare(`INSERT INTO shipments (id, package_id, status) VALUES (?, ?, 'ready_to_ship')`).bind(shipmentId, packageId).run();
    await db
      .prepare(`INSERT INTO awbs (id, shipment_id, awb_code, scanned_at, verified) VALUES (?, ?, ?, datetime('now'), 1)`)
      .bind(newId(), shipmentId, awbCode)
      .run();
  }

  await db.prepare(`UPDATE orders SET status = 'ready_to_ship' WHERE id = ? AND status IN ('packed', 'partial')`).bind(target.orderId).run();
  await db
    .prepare(`INSERT INTO awb_scans (id, warehouse_id, awb_code, order_id, shipment_id, scanned_by) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(newId(), warehouseId, awbCode, target.orderId, shipmentId, userId)
    .run();
  await logAudit(db, { userId, action: 'scan.awb', entityType: 'shipment', entityId: shipmentId, metadata: { awbCode, orderId: target.orderId, prePurchased: !!known } });

  return { shipmentId, awbCode, orderId: target.orderId, externalOrderId: target.externalOrderId, skuSummary: target.skuSummary, unitCount: target.unitCount };
}

export interface ScanLogRow {
  awbCode: string;
  orderId: string;
  externalOrderId: string;
  scannedAt: string;
  imageUrl: string | null;
  skuSummary: string;
  unitCount: number;
}

/** Today's scans, newest first — rebuilds the Scan page's results table from the database on every load, never held only in the browser. */
export async function getTodayScans(db: D1Database, warehouseId: string): Promise<ScanLogRow[]> {
  const rows = await db
    .prepare(
      `SELECT sc.awb_code, sc.order_id, sc.scanned_at, o.external_order_id,
              (SELECT sk.image_url FROM order_items oi JOIN skus sk ON sk.id = oi.sku_id WHERE oi.order_id = o.id ORDER BY oi.id LIMIT 1) AS image_url,
              (SELECT sk.sku_code FROM order_items oi JOIN skus sk ON sk.id = oi.sku_id WHERE oi.order_id = o.id ORDER BY oi.id LIMIT 1) AS first_sku_code,
              (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS item_count,
              (SELECT COALESCE(SUM(oi.quantity_packed), 0) FROM order_items oi WHERE oi.order_id = o.id) AS unit_count
       FROM awb_scans sc JOIN orders o ON o.id = sc.order_id
       WHERE sc.warehouse_id = ? AND sc.scanned_at >= date('now') AND sc.scanned_at < date('now', '+1 day')
       ORDER BY sc.scanned_at DESC
       LIMIT 100`
    )
    .bind(warehouseId)
    .all<{
      awb_code: string;
      order_id: string;
      scanned_at: string;
      external_order_id: string;
      image_url: string | null;
      first_sku_code: string | null;
      item_count: number;
      unit_count: number;
    }>();

  return rows.results.map((r) => ({
    awbCode: r.awb_code,
    orderId: r.order_id,
    externalOrderId: r.external_order_id,
    scannedAt: r.scanned_at,
    imageUrl: r.image_url,
    skuSummary: r.item_count > 1 ? `${r.first_sku_code ?? '—'} +${r.item_count - 1} more` : (r.first_sku_code ?? '—'),
    unitCount: r.unit_count
  }));
}
