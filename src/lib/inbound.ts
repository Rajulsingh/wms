import { newId, logAudit } from './db';

export class InboundError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export interface ReceiveLine {
  skuId?: string;
  newSku?: { skuCode: string; name: string };
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
    if (skuId) {
      const sku = await db.prepare(`SELECT sku_code FROM skus WHERE id = ?`).bind(skuId).first<{ sku_code: string }>();
      if (!sku) throw new InboundError('sku_not_found', 'SKU not found');
      skuCode = sku.sku_code;
    } else {
      if (!line.newSku?.skuCode?.trim() || !line.newSku?.name?.trim()) {
        throw new InboundError('sku_required', 'Pick an existing SKU or provide a code and name for a new one');
      }
      const code = line.newSku.skuCode.trim();
      const existing = await db.prepare(`SELECT id FROM skus WHERE sku_code = ?`).bind(code).first<{ id: string }>();
      if (existing) {
        skuId = existing.id;
      } else {
        skuId = newId();
        await db.prepare(`INSERT INTO skus (id, sku_code, name) VALUES (?, ?, ?)`).bind(skuId, code, line.newSku.name.trim()).run();
      }
      skuCode = code;
    }

    const location = await db.prepare(`SELECT id FROM locations WHERE id = ? AND warehouse_id = ?`).bind(line.locationId, warehouseId).first<{ id: string }>();
    if (!location) throw new InboundError('location_not_found', 'Location not found in this warehouse');

    await db
      .prepare(
        `INSERT INTO inventory (id, sku_id, location_id, quantity_on_hand) VALUES (?, ?, ?, ?)
         ON CONFLICT (sku_id, location_id) DO UPDATE SET quantity_on_hand = quantity_on_hand + excluded.quantity_on_hand, version = version + 1, updated_at = datetime('now')`
      )
      .bind(newId(), skuId, line.locationId, line.quantity)
      .run();

    await db
      .prepare(`INSERT INTO inbound_receipt_lines (id, receipt_id, sku_id, location_id, quantity) VALUES (?, ?, ?, ?, ?)`)
      .bind(newId(), receiptId, skuId, line.locationId, line.quantity)
      .run();

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
