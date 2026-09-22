import { env } from 'cloudflare:workers';
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
  receivedAt: string | null;
}

const RETURN_ROW_SELECT = `
  SELECT r.id, r.warehouse_id AS warehouseId, r.external_order_id AS externalOrderId, r.amazon_rma_id AS amazonRmaId, r.merchant_rma_id AS merchantRmaId,
         r.asin, r.merchant_sku AS merchantSku, r.item_name AS itemName, r.return_reason AS returnReason,
         r.tracking_id AS trackingId, r.return_request_date AS returnRequestDate, r.return_delivery_date AS returnDeliveryDate,
         r.status, s.sku_code AS skuCode, s.name AS skuName, s.image_url AS imageUrl, o.customer_name AS customerName,
         r.label_image_key AS labelImageKey, r.product_image_key AS productImageKey, r.received_at AS receivedAt
  FROM returns r
  LEFT JOIN skus s ON s.id = r.sku_id
  LEFT JOIN orders o ON o.id = r.order_id
`;

/** Synced from Amazon but not yet confirmed physically received — see markReturnReceived, which is what actually moves a row out of here (via scan match or manual fallback). Oldest request first. Not filtered to "today": a return synced days ago and still sitting here genuinely hasn't been received yet, which is exactly what this list is for. */
export async function getExpectedReturns(db: D1Database, warehouseId: string): Promise<ReturnRow[]> {
  const rows = await db
    .prepare(`${RETURN_ROW_SELECT} WHERE r.warehouse_id = ? AND r.status = 'expected' ORDER BY r.return_request_date ASC`)
    .bind(warehouseId)
    .all<ReturnRow>();
  return rows.results;
}

/** Confirmed physically received (via markReturnReceived) but not yet inspected — this, not the raw 'expected' backlog, is what the packer actually scans/selects against. */
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

/**
 * The receiving-stage counterpart to findReturnByScan — same match order
 * (tracking id, then Amazon order id as fallback), but scoped to 'expected'
 * since this is what actually moves a return *into* 'received' in the first
 * place. A real bug this replaces: confirmTodayReceipt used to take
 * whatever number the packer typed and blindly flip that many of the
 * *oldest* expected returns to 'received', with zero connection to which
 * physical boxes the courier actually handed over that day — "3 received"
 * could silently mark three unrelated returns as received while the real
 * three sat untouched. Scanning each box's real AWB and matching it here is
 * the fix: only a return whose own tracking id (or order id) was actually
 * scanned ever moves to 'received'.
 */
export async function findExpectedReturnByScan(db: D1Database, warehouseId: string, code: string): Promise<ReturnRow | null> {
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

/**
 * How many returns this warehouse has actually marked 'received' today —
 * the real, derived count behind return_receipts.received_count,
 * recomputed on every markReturnReceived call rather than trusted as a
 * number someone typed in. Uses plain UTC date('now') boundaries against
 * `received_at` (itself a datetime('now') UTC column) rather than the
 * IST-shifted istDateString() used for otp_date/receipt_date elsewhere in
 * this file — mixing an IST-computed boundary with a UTC-stored timestamp
 * column is exactly the kind of day-boundary mismatch this codebase has
 * been bitten by before (see dashboard.ts/packer.ts's own "today" counts,
 * which use the same plain-UTC pattern for the same reason: column and
 * boundary must be in the same timezone frame, or comparisons silently
 * drift near the day edge).
 */
async function countReceivedToday(db: D1Database, warehouseId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS c FROM returns WHERE warehouse_id = ? AND received_at >= date('now') AND received_at < date('now', '+1 day')`)
    .bind(warehouseId)
    .first<{ c: number }>();
  return row?.c ?? 0;
}

/**
 * Moves one specific return from 'expected' to 'received' — the only way
 * that transition happens now (see findExpectedReturnByScan above and the
 * manual fallback below). Refuses anything not currently 'expected' so a
 * duplicate scan of an already-received return, or a code belonging to a
 * return that hasn't synced as expected at all, fails loudly rather than
 * quietly re-stamping received_at. Also keeps return_receipts.received_count
 * in sync with the real, current count — see countReceivedToday.
 */
export async function markReturnReceived(db: D1Database, warehouseId: string, userId: string, returnId: string, method: 'scan' | 'manual'): Promise<ReturnRow> {
  const existing = await getReturnById(db, returnId);
  if (!existing || existing.warehouseId !== warehouseId) throw new Error('Return not found for this warehouse');
  if (existing.status !== 'expected') {
    throw new Error(existing.status === 'received' ? 'This return was already marked received.' : `This return is "${existing.status}", not awaiting receipt.`);
  }

  await db.prepare(`UPDATE returns SET status = 'received', received_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).bind(returnId).run();
  await logAudit(db, { userId, action: 'return.received', entityType: 'return', entityId: returnId, metadata: { method } });

  const receivedCount = await countReceivedToday(db, warehouseId);
  const receiptDate = istDateString();
  const priorTarget = (await getTodayReceipt(db, warehouseId))?.expectedCount ?? 0;
  await db
    .prepare(
      `INSERT INTO return_receipts (warehouse_id, receipt_date, expected_count, received_count, confirmed_by, confirmed_at) VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT (warehouse_id, receipt_date) DO UPDATE SET received_count = excluded.received_count, confirmed_at = datetime('now')`
    )
    .bind(warehouseId, receiptDate, priorTarget, receivedCount, userId)
    .run();

  const updated = await getReturnById(db, returnId);
  return updated!;
}

/** Scan entry point for receiving — resolves the code to a specific expected return, then marks it received. Throws a clear, packer-facing message when nothing matches, rather than falling back to guessing which return the courier actually handed over. */
export async function receiveReturnByScan(db: D1Database, warehouseId: string, userId: string, code: string): Promise<ReturnRow> {
  const match = await findExpectedReturnByScan(db, warehouseId, code);
  if (!match) throw new Error(`No return awaiting receipt matches "${code.trim()}" — check the code, or use "Mark received" on the right item below if the label is damaged/unreadable.`);
  return markReturnReceived(db, warehouseId, userId, match.id, 'scan');
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
 * Records what the courier *claims* to have handed over — a target for the
 * packer to scan up to, never itself an action on any return row anymore.
 * Replaces the old confirmTodayReceipt, which took this same number and
 * blindly flipped that many of the *oldest* expected returns to 'received'
 * — a real bug found live: "3 received" had zero connection to which three
 * physical boxes the courier actually handed over, so it could silently
 * mark the wrong three while the real three sat untouched forever. Now
 * this only sets `expected_count` (the target); `received_count` is always
 * the real, derived count of returns actually scanned/marked received
 * today (see countReceivedToday) — the two are shown side by side so a
 * courier-claimed vs. actually-verified mismatch is visible, not hidden.
 * Callable more than once per day (a second courier drop just adds to the
 * target); accumulates rather than overwrites, same as before.
 */
export async function setReceivingTarget(db: D1Database, warehouseId: string, userId: string, targetCount: number): Promise<ReturnReceipt> {
  if (!Number.isFinite(targetCount) || targetCount < 0) throw new Error('Received count must be a non-negative number');
  const existing = await getTodayReceipt(db, warehouseId);
  const cumulativeTarget = (existing?.expectedCount ?? 0) + targetCount;
  const receivedCount = await countReceivedToday(db, warehouseId);
  const receiptDate = istDateString();

  await db
    .prepare(
      `INSERT INTO return_receipts (warehouse_id, receipt_date, expected_count, received_count, confirmed_by, confirmed_at) VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT (warehouse_id, receipt_date) DO UPDATE SET expected_count = excluded.expected_count, received_count = excluded.received_count, confirmed_by = excluded.confirmed_by, confirmed_at = datetime('now')`
    )
    .bind(warehouseId, receiptDate, cumulativeTarget, receivedCount, userId)
    .run();
  await logAudit(db, { userId, action: 'return.receipt_target_set', entityType: 'warehouse', entityId: warehouseId, metadata: { addedTarget: targetCount, cumulativeTarget } });

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
 * be 'received' (see markReturnReceived) — a per-row gate, not a day-level
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

/** Full, uncapped export for the admin's CSV download — listReturnsForAdmin's 200-row cap is fine for the on-screen table, but a report needs everything in the given window. Date range is inclusive on returnRequestDate (Amazon's own "DD-Mon-YYYY" text, normalized to ISO at sync time — see parseAmazonReturnDate — so plain string comparison sorts correctly here too). */
export async function listReturnsForExport(db: D1Database, warehouseId: string, fromDate: string, toDate: string): Promise<ReturnRow[]> {
  const rows = await db
    .prepare(`${RETURN_ROW_SELECT} WHERE r.warehouse_id = ? AND r.return_request_date >= ? AND r.return_request_date <= ? ORDER BY r.return_request_date ASC`)
    .bind(warehouseId, fromDate, toDate)
    .all<ReturnRow>();
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

/**
 * Deletes SAFE-T claim label/product photos once Amazon's filing window has
 * definitively closed — the seller's own reasoning, confirmed live: a claim
 * can't be filed more than 30 days after a return is received, no matter
 * what its status is here (safe_to_claim never filed, claim_filed, or
 * otherwise), so past that point the photos serve no further purpose.
 * Anchored on `received_at` (see migration 0036), not `claim_filed_at` —
 * an unfiled safe_to_claim return past 30 days from receipt has already
 * lost its filing window regardless, so there's no "protect it because it
 * might still get filed" case to special-case. Existing rows from before
 * `received_at` existed have it NULL and are simply never touched — no
 * guessing on data this can't reconstruct precisely.
 *
 * Called once a day from the Amazon sync cron tick (see worker.ts) rather
 * than its own trigger — Workers Free plan caps cron triggers at 5 total
 * across the whole account (see wrangler.jsonc) — so this is a cheap,
 * self-contained no-op on every tick that finds nothing due yet.
 */
export async function cleanupExpiredReturnImages(db: D1Database): Promise<{ deleted: number }> {
  const rows = await db
    .prepare(
      `SELECT id, label_image_key, product_image_key FROM returns
       WHERE received_at IS NOT NULL AND received_at < datetime('now', '-30 days')
         AND (label_image_key IS NOT NULL OR product_image_key IS NOT NULL)`
    )
    .all<{ id: string; label_image_key: string | null; product_image_key: string | null }>();

  let deleted = 0;
  for (const row of rows.results) {
    if (env.RETURNS_IMAGES) {
      if (row.label_image_key) await env.RETURNS_IMAGES.delete(row.label_image_key);
      if (row.product_image_key) await env.RETURNS_IMAGES.delete(row.product_image_key);
    }
    await db.prepare(`UPDATE returns SET label_image_key = NULL, product_image_key = NULL, updated_at = datetime('now') WHERE id = ?`).bind(row.id).run();
    deleted++;
  }
  return { deleted };
}
