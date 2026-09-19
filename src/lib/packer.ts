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

/** Verifies the station QR/barcode (packing-station equivalent of the rack check, §4/§8), then opens (or resumes) a pack session for the oldest fully-picked order waiting at this warehouse. */
export async function startNextPackSession(db: D1Database, userId: string, stationQrToken: string, warehouseId: string): Promise<PackSessionState | null> {
  const station = await db.prepare(`SELECT id FROM packing_stations WHERE qr_token = ? AND warehouse_id = ?`).bind(stationQrToken, warehouseId).first<{ id: string }>();
  if (!station) throw new PackerFlowError('unknown_station', 'This station QR code is not recognized');

  const existing = await db
    .prepare(`SELECT id, order_id FROM pack_sessions WHERE station_id = ? AND status = 'in_progress' AND packer_id = ?`)
    .bind(station.id, userId)
    .first<{ id: string; order_id: string }>();
  if (existing) return getPackSessionState(db, existing.id);

  const order = await db
    .prepare(`SELECT id FROM orders WHERE warehouse_id = ? AND status = 'picked' ORDER BY priority DESC, created_at ASC LIMIT 1`)
    .bind(warehouseId)
    .first<{ id: string }>();
  if (!order) return null;

  const sessionId = newId();
  await db
    .prepare(`INSERT INTO pack_sessions (id, order_id, packer_id, station_id, status) VALUES (?, ?, ?, ?, 'in_progress')`)
    .bind(sessionId, order.id, userId, station.id)
    .run();
  await db.prepare(`UPDATE orders SET status = 'packing' WHERE id = ?`).bind(order.id).run();
  await logAudit(db, { userId, action: 'pack.session_start', entityType: 'order', entityId: order.id });

  return getPackSessionState(db, sessionId);
}

export async function getPackSessionState(db: D1Database, packSessionId: string): Promise<PackSessionState> {
  const session = await db.prepare(`SELECT * FROM pack_sessions WHERE id = ?`).bind(packSessionId).first<{ id: string; order_id: string; status: string }>();
  if (!session) throw new PackerFlowError('not_found', 'Pack session not found');

  const items = await db
    .prepare(
      `SELECT oi.id as order_item_id, sk.sku_code, sk.name as sku_name, sk.image_url, oi.quantity_picked as quantity_required, oi.quantity_packed
       FROM order_items oi JOIN skus sk ON sk.id = oi.sku_id
       WHERE oi.order_id = ? AND oi.status IN ('picked', 'packed')`
    )
    .bind(session.order_id)
    .all<PackItemView>();

  const allPacked = items.results.every((i) => i.quantity_packed >= i.quantity_required);
  return { packSessionId: session.id, orderId: session.order_id, status: session.status, items: items.results, allPacked };
}

/**
 * Tap-to-confirm, no barcode scan — the warehouse's internal SKU doesn't
 * match Amazon's SellerSKU and products aren't individually barcoded (the
 * same reason the picker flow dropped scanning; see HANDOFF.md). The packer
 * visually matches the item against its photo/name and taps once, same
 * pattern as picker.ts's confirmQuantity/markPicked.
 */
export async function markPackItem(db: D1Database, userId: string, packSessionId: string, orderItemId: string, quantity: number): Promise<PackSessionState> {
  const state = await getPackSessionState(db, packSessionId);
  if (state.status !== 'in_progress') throw new PackerFlowError('wrong_state', 'This pack session is not in progress');

  const item = state.items.find((i) => i.order_item_id === orderItemId);
  if (!item) throw new PackerFlowError('wrong_item', 'That item is not part of this order');
  if (quantity < 0 || quantity > item.quantity_required) {
    throw new PackerFlowError('bad_quantity', `Quantity must be between 0 and ${item.quantity_required}`);
  }

  await db.prepare(`UPDATE order_items SET quantity_packed = ? WHERE id = ?`).bind(quantity, orderItemId).run();
  await logAudit(db, { userId, action: 'pack.mark_item', entityType: 'order_item', entityId: orderItemId, metadata: { quantity } });

  return getPackSessionState(db, packSessionId);
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
