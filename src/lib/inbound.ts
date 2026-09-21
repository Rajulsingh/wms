import { newId, logAudit } from './db';
import { resolveSkuIdByCode, setMsku, SkuMergeError } from './skus';
import { retryBlockedOrdersForSku } from './orders';
import { getOrganizationIdForWarehouse } from './org-accounts';

export class InboundError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export interface ReceiveLine {
  skuId?: string;
  newSku?: { skuCode: string; name: string };
  // Only meaningful when the SKU (new or existing) doesn't already have one
  // — see setMsku in lib/skus.ts. Optional so existing callers/tests that
  // predate MSKU keep working unchanged.
  msku?: string;
  locationId: string;
  quantity: number;
}

export interface ReceiveLineResult {
  skuId: string;
  skuCode: string;
  locationId: string;
  quantity: number;
}

/**
 * Records incoming stock and puts it away into bins — the counterpart to
 * inventory.ts's reserveInventory, which only ever takes stock out. Inserts
 * or increments the SKU x location `inventory` row via SQLite's
 * `ON CONFLICT ... DO UPDATE` (atomic per row, no CAS retry loop needed —
 * unlike reservation claims, two receipts landing on the same row don't
 * conflict, they just both add).
 */
export async function receiveStock(
  db: D1Database,
  userId: string,
  warehouseId: string,
  reference: string | null,
  lines: ReceiveLine[]
): Promise<{ receiptId: string; lines: ReceiveLineResult[] }> {
  if (!lines.length) throw new InboundError('no_lines', 'Add at least one line to receive');
  const organizationId = await getOrganizationIdForWarehouse(db, warehouseId);

  const receiptId = newId();
  await db
    .prepare(`INSERT INTO inbound_receipts (id, warehouse_id, received_by, reference) VALUES (?, ?, ?, ?)`)
    .bind(receiptId, warehouseId, userId, reference)
    .run();

  const results: ReceiveLineResult[] = [];
  for (const line of lines) {
    if (!Number.isFinite(line.quantity) || line.quantity <= 0) {
      throw new InboundError('bad_quantity', 'Quantity must be greater than zero');
    }

    let skuId = line.skuId;
    let skuCode: string;
    let alreadyHasMsku = false;
    if (skuId) {
      const sku = await db
        .prepare(`SELECT sku_code, msku FROM skus WHERE id = ? AND organization_id = ?`)
        .bind(skuId, organizationId)
        .first<{ sku_code: string; msku: string | null }>();
      if (!sku) throw new InboundError('sku_not_found', 'SKU not found');
      skuCode = sku.sku_code;
      alreadyHasMsku = sku.msku != null;
    } else {
      if (!line.newSku?.skuCode?.trim() || !line.newSku?.name?.trim()) {
        throw new InboundError('sku_required', 'Pick an existing SKU or provide a code and name for a new one');
      }
      // Follows a merge redirect — receiving against an old/duplicate code
      // that's since been merged puts the stock on the surviving SKU
      // instead of the dead one. See lib/skus.ts.
      const code = line.newSku.skuCode.trim();
      const resolvedId = await resolveSkuIdByCode(db, organizationId, code);
      if (resolvedId) {
        skuId = resolvedId;
        const existing = await db.prepare(`SELECT msku FROM skus WHERE id = ?`).bind(resolvedId).first<{ msku: string | null }>();
        alreadyHasMsku = existing?.msku != null;
      } else {
        skuId = newId();
        await db.prepare(`INSERT INTO skus (id, organization_id, sku_code, name) VALUES (?, ?, ?, ?)`).bind(skuId, organizationId, code, line.newSku.name.trim()).run();
      }
      skuCode = code;
    }

    // Assigning (or recognizing) the MSKU is what actually determines the
    // final SKU for this line — if the value typed in already belongs to
    // another SKU, setMsku merges this one into it (see lib/skus.ts), so
    // the resolved id has to be re-read afterward rather than assumed to
    // still be `skuId`.
    if (line.msku?.trim() && !alreadyHasMsku) {
      try {
        await setMsku(db, userId, organizationId, skuCode, line.msku);
      } catch (err) {
        if (err instanceof SkuMergeError) throw new InboundError(err.code, err.message);
        throw err;
      }
      const resolved = await resolveSkuIdByCode(db, organizationId, skuCode);
      if (resolved) skuId = resolved;
    }

    const location = await db.prepare(`SELECT id FROM locations WHERE id = ? AND warehouse_id = ?`).bind(line.locationId, warehouseId).first<{ id: string }>();
    if (!location) throw new InboundError('location_not_found', 'Location not found in this warehouse');

    // `status = 'available'` on the UPDATE branch matters as much as the
    // quantity itself — real incident: a bin got flagged 'damaged' by a
    // picker's report, then real, good stock was received into that exact
    // (sku, location) later. The old UPSERT only added to quantity_on_hand
    // and left `status` untouched, so the freshly-received units silently
    // inherited the stale 'damaged' flag — reserveInventory (inventory.ts)
    // filters `status = 'available'` and never even considers a 'damaged'
    // row regardless of quantity, so the order kept reporting "0 in stock"
    // even with real units physically on the shelf. Receiving is an
    // explicit human action confirming what's in that bin right now is
    // good — the same correction signal this app already uses elsewhere
    // (e.g. an admin's SKU merge), so it's the right moment to clear a
    // stale damage flag, not something that needs its own separate step.
    await db
      .prepare(
        `INSERT INTO inventory (id, sku_id, location_id, quantity_on_hand) VALUES (?, ?, ?, ?)
         ON CONFLICT (sku_id, location_id) DO UPDATE SET quantity_on_hand = quantity_on_hand + excluded.quantity_on_hand, status = 'available', version = version + 1, updated_at = datetime('now')`
      )
      .bind(newId(), skuId, line.locationId, line.quantity)
      .run();

    await db
      .prepare(`INSERT INTO inbound_receipt_lines (id, receipt_id, sku_id, location_id, quantity) VALUES (?, ?, ?, ?, ?)`)
      .bind(newId(), receiptId, skuId, line.locationId, line.quantity)
      .run();

    // Stock just arrived for this SKU — resolve any order that was blocked
    // on it immediately, rather than waiting for a picker's next poll or an
    // admin's manual retry. See retryBlockedOrdersForSku in lib/orders.ts.
    await retryBlockedOrdersForSku(db, warehouseId, skuId);

    results.push({ skuId, skuCode, locationId: line.locationId, quantity: line.quantity });
  }

  await logAudit(db, { userId, action: 'inbound.receive', entityType: 'inbound_receipt', entityId: receiptId, metadata: { reference, lines: results } });

  return { receiptId, lines: results };
}

export interface ReceiptView {
  id: string;
  reference: string | null;
  received_by_name: string | null;
  created_at: string;
  line_count: number;
  total_quantity: number;
}

export async function listReceipts(db: D1Database, warehouseId: string): Promise<ReceiptView[]> {
  const rows = await db
    .prepare(
      `SELECT r.id, r.reference, u.name AS received_by_name, r.created_at,
              COUNT(l.id) AS line_count, COALESCE(SUM(l.quantity), 0) AS total_quantity
       FROM inbound_receipts r
       LEFT JOIN users u ON u.id = r.received_by
       LEFT JOIN inbound_receipt_lines l ON l.receipt_id = r.id
       WHERE r.warehouse_id = ?
       GROUP BY r.id
       ORDER BY r.created_at DESC
       LIMIT 50`
    )
    .bind(warehouseId)
    .all<ReceiptView>();
  return rows.results;
}
