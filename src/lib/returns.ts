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

/** Synced from Amazon but not yet confirmed physically received — see confirmTodayReceipt, which is what actually moves a row out of here. Oldest request first. Not filtered to "today": a return synced days ago and still sitting here genuinely hasn't been received yet, which is exactly what this list is for. */
export async function getExpectedReturns(db: D1Database, warehouseId: string): Promise<ReturnRow[]> {
  const rows = await db
    .prepare(`${RETURN_ROW_SELECT} WHERE r.warehouse_id = ? AND r.status = 'expected' ORDER BY r.return_request_date ASC`)
    .bind(warehouseId)
    .all<ReturnRow>();
  return rows.results;
}

/** Confirmed physically received (via confirmTodayReceipt) but not yet inspected — this, not the raw 'expected' backlog, is what the packer actually scans/selects against. */
export async function getReceivedReturns(db: D1Database, warehouseId: string): Promise<ReturnRow[]> {
  const rows = await db
    .prepare(`${RETURN_ROW_SELECT} WHERE r.warehouse_id = ? AND r.status = 'received' ORDER BY r.return_request_date ASC`)
    .bind(warehouseId)
    .all<ReturnRow>();
  return rows.results;
}

export async function getReturnById(db: D1Database, returnId: string): Promise<ReturnRow | null> {
  const row = await db.prepare(`${RETURN_ROW_SELECT} WHERE r.id = ?`).bind(returnId).first<ReturnRow>();
  return row ?? null;
}

/** Matches a return to this AWB/tracking id scanned on the floor — the packer's entry point into inspecting one specific package, only among what's already confirmed received (see getReceivedReturns). Falls back to matching on Amazon order id, since a self-printed or handwritten label might not carry the tracking id Amazon's report has. */
export async function findReturnByScan(db: D1Database, warehouseId: string, code: string): Promise<ReturnRow | null> {
  const trimmed = code.trim();
  if (!trimmed) return null;
  const byTracking = await db
    .prepare(`${RETURN_ROW_SELECT} WHERE r.warehouse_id = ? AND r.tracking_id = ? AND r.status = 'received' ORDER BY r.return_request_date ASC LIMIT 1`)
    .bind(warehouseId, trimmed)
    .first<ReturnRow>();
  if (byTracking) return byTracking;
  return db
    .prepare(`${RETURN_ROW_SELECT} WHERE r.warehouse_id = ? AND r.external_order_id = ? AND r.status = 'received' ORDER BY r.return_request_date ASC LIMIT 1`)
    .bind(warehouseId, trimmed)
    .first<ReturnRow>();
}

export interface ReturnReceipt {
  expectedCount: number;
  receivedCount: number;
  confirmedAt: string;
}

export async function getTodayReceipt(db: D1Database, warehouseId: string): Promise<ReturnReceipt | null> {
  const row = await db
    .prepare(`SELECT expected_count AS expectedCount, received_count AS receivedCount, confirmed_at AS confirmedAt FROM return_receipts WHERE warehouse_id = ? AND receipt_date = ?`)
    .bind(warehouseId, istDateString())
    .first<ReturnReceipt>();
  return row ?? null;
}

/**
 * The packer's headcount reconciliation — and the only thing that actually
 * moves a return out of "expected" and into "received" (see
 * getReceivedReturns). A real bug found live: the original version of this
 * only recorded a number, never touched any individual row, so the
 * "expected today" list kept re-showing the same accumulated backlog every
 * day forever, including returns already confirmed received days earlier.
 *
 * `receivedCount` is a delta, not an absolute total — callable more than
 * once per day (a second courier drop later the same day just adds more),
 * each call transitioning that many more of the oldest still-'expected'
 * rows to 'received'. The stored `receivedCount` accumulates across calls;
 * `expectedCount` is recomputed each time as received-so-far plus
 * whatever's still outstanding, so it always reads as "the total this
 * warehouse has seen today," not a stale first-call snapshot.
 */
export async function confirmTodayReceipt(db: D1Database, warehouseId: string, userId: string, receivedCount: number): Promise<ReturnReceipt> {
  if (!Number.isFinite(receivedCount) || receivedCount < 0) throw new Error('Received count must be a non-negative number');
  const expected = await getExpectedReturns(db, warehouseId);
  const toReceive = expected.slice(0, Math.min(receivedCount, expected.length));

  for (const r of toReceive) {
    await db.prepare(`UPDATE returns SET status = 'received', updated_at = datetime('now') WHERE id = ?`).bind(r.id).run();
  }
  if (toReceive.length) {
    await logAudit(db, {
      userId,
      action: 'return.received',
      entityType: 'warehouse',
      entityId: warehouseId,
      metadata: { count: toReceive.length, returnIds: toReceive.map((r) => r.id) }
    });
  }

  const receiptDate = istDateString();
  const existing = await getTodayReceipt(db, warehouseId);
  const cumulativeReceived = (existing?.receivedCount ?? 0) + toReceive.length;
  const stillExpected = expected.length - toReceive.length;

  await db
    .prepare(
      `INSERT INTO return_receipts (warehouse_id, receipt_date, expected_count, received_count, confirmed_by, confirmed_at) VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT (warehouse_id, receipt_date) DO UPDATE SET expected_count = excluded.expected_count, received_count = excluded.received_count, confirmed_by = excluded.confirmed_by, confirmed_at = datetime('now')`
    )
    .bind(warehouseId, receiptDate, cumulativeReceived + stillExpected, cumulativeReceived, userId)
    .run();
  await logAudit(db, { userId, action: 'return.receipt_confirmed', entityType: 'warehouse', entityId: warehouseId, metadata: { receivedNow: toReceive.length, cumulativeReceived } });

  const confirmed = await getTodayReceipt(db, warehouseId);
  return confirmed!;
}

export interface ReturnReceiptHistoryRow extends ReturnReceipt {
  receiptDate: string;
  confirmedByName: string | null;
}

/** Admin-facing history of the packer's daily headcount confirmations — the "as reported by packers" side of the Returns page, alongside the inspection queue. */
export async function listRecentReceipts(db: D1Database, warehouseId: string, limit = 14): Promise<ReturnReceiptHistoryRow[]> {
  const rows = await db
    .prepare(
      `SELECT rr.receipt_date AS receiptDate, rr.expected_count AS expectedCount, rr.received_count AS receivedCount, rr.confirmed_at AS confirmedAt, u.name AS confirmedByName
       FROM return_receipts rr LEFT JOIN users u ON u.id = rr.confirmed_by
       WHERE rr.warehouse_id = ? ORDER BY rr.receipt_date DESC LIMIT ?`
    )
    .bind(warehouseId, limit)
    .all<ReturnReceiptHistoryRow>();
  return rows.results;
}

const INSPECTION_STATUSES = ['ready_to_repack', 'unsellable', 'safe_to_claim'] as const;
export type InspectionStatus = (typeof INSPECTION_STATUSES)[number];

/**
 * Records the packer's inspection outcome. Requires the return to already
 * be 'received' (see confirmTodayReceipt) — a per-row gate, not a day-level
 * one: only returns actually confirmed off the courier are inspectable,
 * regardless of what else happened to be confirmed today. `safe_to_claim`
 * requires both images (label + product) — that's what lets the admin
 * actually file the SAFE-T claim afterward; the other two outcomes need
 * neither.
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
  const row = await db.prepare(`SELECT status FROM returns WHERE id = ?`).bind(returnId).first<{ status: string }>();
  if (!row) throw new Error('Return not found');
  if (row.status !== 'received') {
    throw new Error('This return must be confirmed received before it can be inspected — see the receiving count above the OTP.');
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

export async function getTodayOtp(db: D1Database, warehouseId: string): Promise<{ otp: string; setAt: string; validForCount: number | null } | null> {
  const row = await db
    .prepare(`SELECT otp, set_at AS setAt, valid_for_count AS validForCount FROM return_otps WHERE warehouse_id = ? AND otp_date = ?`)
    .bind(warehouseId, istDateString())
    .first<{ otp: string; setAt: string; validForCount: number | null }>();
  return row ?? null;
}

export async function setTodayOtp(db: D1Database, warehouseId: string, userId: string, otp: string, validForCount: number | null): Promise<void> {
  const trimmed = otp.trim();
  if (!trimmed) throw new Error('OTP is required');
  if (validForCount !== null && (!Number.isFinite(validForCount) || validForCount < 0)) {
    throw new Error('Valid-for count must be a non-negative number');
  }
  await db
    .prepare(
      `INSERT INTO return_otps (warehouse_id, otp_date, otp, valid_for_count, set_by, set_at) VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT (warehouse_id, otp_date) DO UPDATE SET otp = excluded.otp, valid_for_count = excluded.valid_for_count, set_by = excluded.set_by, set_at = datetime('now')`
    )
    .bind(warehouseId, istDateString(), trimmed, validForCount, userId)
    .run();
  await logAudit(db, { userId, action: 'return.otp_set', entityType: 'warehouse', entityId: warehouseId, metadata: { validForCount } });
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

  // First sync ever for this warehouse (no watermark yet) looks back 30
  // days, not just 48h — this is a brand new feature being turned on
  // against an account that may already have open returns sitting in
  // Seller Central from before it existed. 48h would be right for a
  // steady-state gap (cron was down, nobody logged in), but wrong for a
  // cold start: since the window only ever moves forward from here, a
  // return older than the first run's lookback would never be caught by
  // any later run either. 30 days matches Seller Central's own default
  // "Manage Returns" filter, so a fresh sync sees everything a human
  // checking that page would see right now.
  const since = wh.amazon_returns_synced_through ? new Date(wh.amazon_returns_synced_through) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const { reportId } = await requestReturnsReport(since.toISOString(), new Date().toISOString(), credentials);
  await db.prepare(`UPDATE warehouses SET returns_report_pending_id = ?, returns_report_requested_at = datetime('now') WHERE id = ?`).bind(reportId, warehouseId).run();
  return { imported: 0, status: 'REQUESTED' };
}

const RETURN_DATE_MONTHS: Record<string, string> = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12'
};

/**
 * Amazon's actual return_request_date/return_delivery_date value is
 * "DD-Mon-YYYY" text (confirmed live against real production rows: e.g.
 * "02-Sep-2026") — not the ISO format every other date in this app
 * assumes. A real bug found live: string-sorting/slicing that format
 * doesn't behave like ISO, and it silently broke both the "oldest first"
 * ordering and the admin table's date column. Normalized here at
 * ingestion so every downstream comparison can keep assuming ISO, same as
 * everywhere else, rather than teaching each call site Amazon's format.
 * An unrecognized shape is logged and passed through as-is rather than
 * dropped — a future report-format change should be loud, not silent.
 */
function parseAmazonReturnDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return trimmed.slice(0, 10);
  const m = trimmed.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (m && RETURN_DATE_MONTHS[m[2]]) return `${m[3]}-${RETURN_DATE_MONTHS[m[2]]}-${m[1].padStart(2, '0')}`;
  console.error(`Returns sync: unrecognized date format "${raw}" — check parseAmazonReturnDate in lib/returns.ts against a real report.`);
  return trimmed;
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
        parseAmazonReturnDate(row.returnRequestDate),
        parseAmazonReturnDate(row.returnDeliveryDate)
      )
      .run();
    imported++;
  }
  return imported;
}
