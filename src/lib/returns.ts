import { newId, logAudit } from './db';
import { requestReturnsReport, checkReturnsReport, type ReturnsReportRow, type AmazonEnv } from './amazon';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
function istDateString(ms = Date.now()): string {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

export interface ReturnRow {
  id: string;
  warehouseId: string;
  externalOrderId: string;
  amazonRmaId: string | null;
  merchantRmaId: string | null;
  asin: string | null;
  merchantSku: string | null;
  itemName: string | null;
  returnReason: string | null;
  trackingId: string | null;
  returnRequestDate: string | null;
  returnDeliveryDate: string | null;
  status: string;
  skuCode: string | null;
  skuName: string | null;
  imageUrl: string | null;
  customerName: string | null;
  labelImageKey: string | null;
  productImageKey: string | null;
}

const RETURN_ROW_SELECT = `
  SELECT r.id, r.warehouse_id AS warehouseId, r.external_order_id AS externalOrderId, r.amazon_rma_id AS amazonRmaId, r.merchant_rma_id AS merchantRmaId,
         r.asin, r.merchant_sku AS merchantSku, r.item_name AS itemName, r.return_reason AS returnReason,
         r.tracking_id AS trackingId, r.return_request_date AS returnRequestDate, r.return_delivery_date AS returnDeliveryDate,
         r.status, s.sku_code AS skuCode, s.name AS skuName, s.image_url AS imageUrl, o.customer_name AS customerName,
         r.label_image_key AS labelImageKey, r.product_image_key AS productImageKey
  FROM returns r
  LEFT JOIN skus s ON s.id = r.sku_id
  LEFT JOIN orders o ON o.id = r.order_id
`;

/** The packer's queue: returns synced from Amazon but not yet physically inspected. Oldest request first — those have been waiting longest. */
export async function getExpectedReturns(db: D1Database, warehouseId: string): Promise<ReturnRow[]> {
  const rows = await db
    .prepare(`${RETURN_ROW_SELECT} WHERE r.warehouse_id = ? AND r.status = 'expected' ORDER BY r.return_request_date ASC`)
    .bind(warehouseId)
    .all<ReturnRow>();
  return rows.results;
}

export async function getReturnById(db: D1Database, returnId: string): Promise<ReturnRow | null> {
  const row = await db.prepare(`${RETURN_ROW_SELECT} WHERE r.id = ?`).bind(returnId).first<ReturnRow>();
  return row ?? null;
}

/** Matches a return to this AWB/tracking id scanned on the floor — the packer's entry point into inspecting one specific package. Falls back to matching on Amazon order id, since a self-printed or handwritten label might not carry the tracking id Amazon's report has. */
export async function findReturnByScan(db: D1Database, warehouseId: string, code: string): Promise<ReturnRow | null> {
  const trimmed = code.trim();
  if (!trimmed) return null;
  const byTracking = await db
    .prepare(`${RETURN_ROW_SELECT} WHERE r.warehouse_id = ? AND r.tracking_id = ? AND r.status = 'expected' ORDER BY r.return_request_date ASC LIMIT 1`)
    .bind(warehouseId, trimmed)
    .first<ReturnRow>();
  if (byTracking) return byTracking;
  return db
    .prepare(`${RETURN_ROW_SELECT} WHERE r.warehouse_id = ? AND r.external_order_id = ? AND r.status = 'expected' ORDER BY r.return_request_date ASC LIMIT 1`)
    .bind(warehouseId, trimmed)
    .first<ReturnRow>();
}

const INSPECTION_STATUSES = ['ready_to_repack', 'unsellable', 'safe_to_claim'] as const;
export type InspectionStatus = (typeof INSPECTION_STATUSES)[number];

/**
 * Records the packer's inspection outcome. `safe_to_claim` requires both
 * images (label + product) — that's what lets the admin actually file the
 * SAFE-T claim afterward; the other two outcomes need neither.
 */
export async function recordReturnInspection(
  db: D1Database,
  returnId: string,
  userId: string,
  status: InspectionStatus,
  images: { labelImageKey?: string; productImageKey?: string }
): Promise<void> {
  if (!INSPECTION_STATUSES.includes(status)) throw new Error(`Invalid inspection status: ${status}`);
  if (status === 'safe_to_claim' && (!images.labelImageKey || !images.productImageKey)) {
    throw new Error('Safe-to-claim requires both a label photo and a product photo');
  }
  await db
    .prepare(
      `UPDATE returns SET status = ?, inspected_by = ?, inspected_at = datetime('now'), label_image_key = ?, product_image_key = ?, updated_at = datetime('now') WHERE id = ?`
    )
    .bind(status, userId, images.labelImageKey ?? null, images.productImageKey ?? null, returnId)
    .run();
  await logAudit(db, { userId, action: 'return.inspect', entityType: 'return', entityId: returnId, metadata: { status } });
}

export async function listReturnsForAdmin(db: D1Database, warehouseId: string, status?: string): Promise<ReturnRow[]> {
  if (status) {
    const rows = await db.prepare(`${RETURN_ROW_SELECT} WHERE r.warehouse_id = ? AND r.status = ? ORDER BY r.return_request_date DESC`).bind(warehouseId, status).all<ReturnRow>();
    return rows.results;
  }
  const rows = await db.prepare(`${RETURN_ROW_SELECT} WHERE r.warehouse_id = ? ORDER BY r.return_request_date DESC LIMIT 200`).bind(warehouseId).all<ReturnRow>();
  return rows.results;
}

export async function markClaimFiled(db: D1Database, returnId: string, userId: string): Promise<void> {
  const row = await db.prepare(`SELECT status FROM returns WHERE id = ?`).bind(returnId).first<{ status: string }>();
  if (!row) throw new Error('Return not found');
  if (row.status !== 'safe_to_claim') throw new Error('Only a return marked "safe to claim" can be marked claim filed');
  await db.prepare(`UPDATE returns SET status = 'claim_filed', claim_filed_by = ?, claim_filed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).bind(userId, returnId).run();
  await logAudit(db, { userId, action: 'return.claim_filed', entityType: 'return', entityId: returnId, metadata: {} });
}

export async function getTodayOtp(db: D1Database, warehouseId: string): Promise<{ otp: string; setAt: string } | null> {
  const row = await db
    .prepare(`SELECT otp, set_at AS setAt FROM return_otps WHERE warehouse_id = ? AND otp_date = ?`)
    .bind(warehouseId, istDateString())
    .first<{ otp: string; setAt: string }>();
  return row ?? null;
}

export async function setTodayOtp(db: D1Database, warehouseId: string, userId: string, otp: string): Promise<void> {
  const trimmed = otp.trim();
  if (!trimmed) throw new Error('OTP is required');
  await db
    .prepare(
      `INSERT INTO return_otps (warehouse_id, otp_date, otp, set_by, set_at) VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT (warehouse_id, otp_date) DO UPDATE SET otp = excluded.otp, set_by = excluded.set_by, set_at = datetime('now')`
    )
    .bind(warehouseId, istDateString(), trimmed, userId)
    .run();
  await logAudit(db, { userId, action: 'return.otp_set', entityType: 'warehouse', entityId: warehouseId, metadata: {} });
}

/**
 * One cron-tick step of the returns sync (see sync-job.ts) — mirrors
 * amazon_orders_synced_through's watermark pattern, but the report itself
 * is async (request -> poll -> download), so a report id in flight has to
 * survive across multiple ticks rather than resolving inline like GetOrders
 * does. At most one request/poll per warehouse per tick.
 */
export async function syncReturnsReport(db: D1Database, warehouseId: string, credentials?: Partial<AmazonEnv>): Promise<{ imported: number; status: string }> {
  const wh = await db
    .prepare(`SELECT amazon_returns_synced_through, returns_report_pending_id, returns_report_requested_at FROM warehouses WHERE id = ?`)
    .bind(warehouseId)
    .first<{ amazon_returns_synced_through: string | null; returns_report_pending_id: string | null; returns_report_requested_at: string | null }>();
  if (!wh) return { imported: 0, status: 'no-warehouse' };

  if (wh.returns_report_pending_id) {
    const result = await checkReturnsReport(wh.returns_report_pending_id, credentials);
    if (result.status === 'DONE') {
      const imported = await upsertReturnsRows(db, warehouseId, result.rows ?? []);
      await db
        .prepare(`UPDATE warehouses SET returns_report_pending_id = NULL, returns_report_requested_at = NULL, amazon_returns_synced_through = datetime('now') WHERE id = ?`)
        .bind(warehouseId)
        .run();
      return { imported, status: 'DONE' };
    }
    // A report stuck for over 2 hours is not coming back — drop it so the
    // next tick requests a fresh one instead of polling forever.
    const requestedAtMs = wh.returns_report_requested_at ? new Date(wh.returns_report_requested_at).getTime() : 0;
    const stale = Date.now() - requestedAtMs > 2 * 60 * 60 * 1000;
    if (result.status === 'FATAL' || result.status === 'CANCELLED' || stale) {
      await db.prepare(`UPDATE warehouses SET returns_report_pending_id = NULL, returns_report_requested_at = NULL WHERE id = ?`).bind(warehouseId).run();
      return { imported: 0, status: stale ? 'STALE' : result.status };
    }
    return { imported: 0, status: result.status };
  }

  const since = wh.amazon_returns_synced_through ? new Date(wh.amazon_returns_synced_through) : new Date(Date.now() - 48 * 60 * 60 * 1000);
  const { reportId } = await requestReturnsReport(since.toISOString(), new Date().toISOString(), credentials);
  await db.prepare(`UPDATE warehouses SET returns_report_pending_id = ?, returns_report_requested_at = datetime('now') WHERE id = ?`).bind(reportId, warehouseId).run();
  return { imported: 0, status: 'REQUESTED' };
}

async function upsertReturnsRows(db: D1Database, warehouseId: string, rows: ReturnsReportRow[]): Promise<number> {
  let imported = 0;
  for (const row of rows) {
    if (!row.amazonRmaId) continue; // can't upsert safely without the unique key — see the UNIQUE(warehouse_id, amazon_rma_id) constraint in migration 0030

    const order = row.orderId
      ? await db.prepare(`SELECT id FROM orders WHERE warehouse_id = ? AND source = 'amazon' AND external_order_id = ?`).bind(warehouseId, row.orderId).first<{ id: string }>()
      : null;
    const sku = row.asin
      ? await db.prepare(`SELECT id FROM skus WHERE asin = ?`).bind(row.asin).first<{ id: string }>()
      : row.merchantSku
        ? await db.prepare(`SELECT id FROM skus WHERE sku_code = ? OR msku = ?`).bind(row.merchantSku, row.merchantSku).first<{ id: string }>()
        : null;

    await db
      .prepare(
        `INSERT INTO returns (id, warehouse_id, order_id, sku_id, external_order_id, amazon_rma_id, merchant_rma_id, asin, merchant_sku, item_name, return_reason, tracking_id, return_request_date, return_delivery_date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (warehouse_id, amazon_rma_id) DO UPDATE SET
           order_id = excluded.order_id,
           sku_id = excluded.sku_id,
           tracking_id = excluded.tracking_id,
           return_delivery_date = excluded.return_delivery_date,
           item_name = excluded.item_name,
           return_reason = excluded.return_reason,
           updated_at = datetime('now')`
      )
      .bind(
        newId(),
        warehouseId,
        order?.id ?? null,
        sku?.id ?? null,
        row.orderId,
        row.amazonRmaId,
        row.merchantRmaId || null,
        row.asin || null,
        row.merchantSku || null,
        row.itemName || null,
        row.returnReason || null,
        row.trackingId || null,
        row.returnRequestDate || null,
        row.returnDeliveryDate || null
      )
      .run();
    imported++;
  }
  return imported;
}
