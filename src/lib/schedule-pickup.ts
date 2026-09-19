import { newId, logAudit } from './db';
import { extractPageTexts, matchPagesToOrders, buildStampedOrderPdf, type MatchCandidate } from './label-pdf';

export class SchedulePickupError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

// Amazon's own exact column order for the Schedule Pickup upload file —
// confirmed against ess_template_with_tpncy_code_latest.xlsx's "Schedule
// Pickup" sheet, not guessed.
const COLUMNS = [
  'order_id',
  'invoice_id',
  'package_weight',
  'package_length',
  'package_width',
  'package_height',
  'schedule_pickup_date',
  'schedule_pickup_time',
  'merchant_additional_identifier',
  'transparency_code'
];
const MAX_ROWS_PER_FILE = 500; // Amazon's stated per-feed cap.

async function loadOrderAndBoxCm(
  db: D1Database,
  orderId: string,
  boxSizeId: string
): Promise<{ order: { id: string; warehouseId: string; externalOrderId: string }; lengthCm: number; widthCm: number; heightCm: number }> {
  const order = await db
    .prepare(`SELECT id, warehouse_id, external_order_id, source FROM orders WHERE id = ?`)
    .bind(orderId)
    .first<{ id: string; warehouse_id: string; external_order_id: string; source: string }>();
  if (!order) throw new SchedulePickupError('not_found', 'Order not found');
  if (order.source !== 'amazon') {
    throw new SchedulePickupError('not_amazon_order', 'Only Amazon-sourced orders have an Amazon order id to schedule a pickup for.');
  }

  const box = await db
    .prepare(`SELECT length, width, height, dimension_unit FROM box_sizes WHERE id = ? AND warehouse_id = ?`)
    .bind(boxSizeId, order.warehouse_id)
    .first<{ length: number; width: number; height: number; dimension_unit: string }>();
  if (!box) throw new SchedulePickupError('box_not_found', 'Box size not found for this warehouse');

  const toCm = (v: number) => (box.dimension_unit === 'inches' ? v * 2.54 : v);
  return {
    order: { id: order.id, warehouseId: order.warehouse_id, externalOrderId: order.external_order_id },
    lengthCm: toCm(box.length),
    widthCm: toCm(box.width),
    heightCm: toCm(box.height)
  };
}

export async function createScheduleBatch(
  db: D1Database,
  userId: string,
  warehouseId: string,
  pickupDate: string,
  pickupTime: '11:00 AM' | '2:00 PM'
): Promise<string> {
  const batchId = newId();
  await db
    .prepare(`INSERT INTO schedule_pickup_batches (id, warehouse_id, pickup_date, pickup_time, created_by) VALUES (?, ?, ?, ?, ?)`)
    .bind(batchId, warehouseId, pickupDate, pickupTime, userId)
    .run();
  return batchId;
}

export interface ScheduleOrderInput {
  orderId: string;
  boxSizeId: string;
  weightGrams: number;
  invoiceId: string;
  merchantIdentifier?: string;
}

export interface GenerateFileResult {
  batchId: string;
  files: string[]; // tab-delimited text, chunked at MAX_ROWS_PER_FILE data rows each, header repeated
}

/**
 * Creates the local packages/shipments rows (same "committed" status
 * semantics the SP-API path already uses — see scheduleEasyShipForOrder in
 * shipping.ts — even though no real label exists yet) and builds the
 * tab-delimited text Amazon's Schedule Pickup upload expects. The admin
 * still has to actually upload this file themselves; nothing here talks to
 * Amazon.
 */
export async function generateScheduleFile(
  db: D1Database,
  userId: string,
  warehouseId: string,
  batchId: string,
  orders: ScheduleOrderInput[]
): Promise<GenerateFileResult> {
  if (!orders.length) throw new SchedulePickupError('no_orders', 'Select at least one order');
  const batch = await db
    .prepare(`SELECT pickup_date, pickup_time FROM schedule_pickup_batches WHERE id = ? AND warehouse_id = ?`)
    .bind(batchId, warehouseId)
    .first<{ pickup_date: string; pickup_time: string }>();
  if (!batch) throw new SchedulePickupError('not_found', 'Schedule batch not found');

  const dataRows: string[] = [];
  for (const input of orders) {
    const { order, lengthCm, widthCm, heightCm } = await loadOrderAndBoxCm(db, input.orderId, input.boxSizeId);
    // Amazon assumes the largest dimension is length, then width, then height.
    const [outLength, outWidth, outHeight] = [lengthCm, widthCm, heightCm].sort((a, b) => b - a);

    const packageId = newId();
    await db
      .prepare(`INSERT INTO packages (id, order_id, status, box_size_id, weight_value, weight_unit) VALUES (?, ?, 'labeled', ?, ?, 'grams')`)
      .bind(packageId, input.orderId, input.boxSizeId, input.weightGrams)
      .run();

    const shipmentId = newId();
    await db
      .prepare(
        `INSERT INTO shipments (id, package_id, carrier, status, package_identifier, invoice_id, schedule_batch_id, manual_schedule_status)
         VALUES (?, ?, 'amazon-easyship-manual', 'label_applied', ?, ?, ?, 'file_generated')`
      )
      .bind(shipmentId, packageId, input.merchantIdentifier?.trim() || null, input.invoiceId, batchId)
      .run();

    dataRows.push(
      [
        order.externalOrderId,
        input.invoiceId,
        input.weightGrams.toFixed(2),
        outLength.toFixed(2),
        outWidth.toFixed(2),
        outHeight.toFixed(2),
        batch.pickup_date,
        batch.pickup_time,
        input.merchantIdentifier?.trim() ?? '',
        ''
      ].join('\t')
    );
  }

  await logAudit(db, { userId, action: 'shipping.schedule_file_generated', entityType: 'warehouse', entityId: warehouseId, metadata: { batchId, orderCount: orders.length } });

  const header = COLUMNS.join('\t');
  const files: string[] = [];
  for (let i = 0; i < dataRows.length; i += MAX_ROWS_PER_FILE) {
    files.push([header, ...dataRows.slice(i, i + MAX_ROWS_PER_FILE)].join('\n'));
  }
  return { batchId, files };
}

interface PendingBatchShipment {
  shipmentId: string;
  orderId: string;
  externalOrderId: string;
  invoiceId: string | null;
  packageIdentifier: string | null;
  skuSummary: string;
}

async function getPendingBatchShipments(db: D1Database, batchId: string): Promise<PendingBatchShipment[]> {
  const rows = await db
    .prepare(
      `SELECT s.id AS shipment_id, p.order_id, o.external_order_id, s.invoice_id, s.package_identifier,
              (SELECT sk.sku_code FROM order_items oi JOIN skus sk ON sk.id = oi.sku_id WHERE oi.order_id = p.order_id ORDER BY oi.id LIMIT 1) AS first_sku_code,
              (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = p.order_id) AS item_count
       FROM shipments s
       JOIN packages p ON p.id = s.package_id
       JOIN orders o ON o.id = p.order_id
       WHERE s.schedule_batch_id = ? AND s.manual_schedule_status = 'file_generated'
       ORDER BY s.created_at ASC`
    )
    .bind(batchId)
    .all<{
      shipment_id: string;
      order_id: string;
      external_order_id: string;
      invoice_id: string | null;
      package_identifier: string | null;
      first_sku_code: string | null;
      item_count: number;
    }>();

  return rows.results.map((r) => ({
    shipmentId: r.shipment_id,
    orderId: r.order_id,
    externalOrderId: r.external_order_id,
    invoiceId: r.invoice_id,
    packageIdentifier: r.package_identifier,
    skuSummary: r.item_count > 1 ? `${r.first_sku_code ?? '—'} +${r.item_count - 1} more` : r.first_sku_code ?? '—'
  }));
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

async function finalizeMatchedShipment(db: D1Database, shipment: PendingBatchShipment, pdfBytes: Uint8Array, pageIndices: number[]): Promise<void> {
  const stampLines = [shipment.packageIdentifier, shipment.skuSummary].filter((l): l is string => !!l && l.trim().length > 0);
  const stamped = await buildStampedOrderPdf(pdfBytes, pageIndices, stampLines);
  const base64 = toBase64(stamped);

  // label_status is also set here (not just manual_schedule_status) so the
  // existing /api/admin/shipping/label-status endpoint — and bulk-ship.astro's
  // print/download UI built on it — work unchanged for a manually-produced
  // label too, without needing to know which path made it.
  await db
    .prepare(
      `UPDATE shipments SET label_base64 = ?, label_file_type = 'application/pdf', label_status = 'document_ready', manual_schedule_status = 'labels_received' WHERE id = ?`
    )
    .bind(base64, shipment.shipmentId)
    .run();

  const awbExisting = await db.prepare(`SELECT id FROM awbs WHERE shipment_id = ?`).bind(shipment.shipmentId).first<{ id: string }>();
  if (!awbExisting) {
    // No real tracking number is reliably extractable from page text alone —
    // invoice_id is guaranteed unique per shipment (see generateScheduleFile)
    // and is enough to satisfy awbs' uniqueness without inventing one.
    await db
      .prepare(`INSERT INTO awbs (id, shipment_id, awb_code, scanned_at, verified) VALUES (?, ?, ?, datetime('now'), 1)`)
      .bind(newId(), shipment.shipmentId, shipment.invoiceId ?? shipment.shipmentId)
      .run();
  }

  await db.prepare(`UPDATE orders SET status = 'ready_to_ship' WHERE id = ? AND status IN ('packed', 'partial')`).bind(shipment.orderId).run();
}

export interface UploadedLabelSummary {
  matched: Array<{ shipmentId: string; orderId: string; externalOrderId: string; pageCount: number }>;
  unmatchedPages: Array<{ pageIndex: number; snippet: string }>;
}

/**
 * Splits the label+invoice PDF the admin downloaded from Seller Central back
 * into one stamped PDF per order, storing each on its shipment row exactly
 * like the SP-API path does (label_base64/label_file_type) so nothing that
 * shows/downloads a label needs to know which path produced it. Matching is
 * text-based, not positional — see label-pdf.ts — since the real page layout
 * of Amazon's manual export hasn't been seen yet.
 */
export async function processUploadedLabelPdf(db: D1Database, userId: string, warehouseId: string, batchId: string, pdfBytes: Uint8Array): Promise<UploadedLabelSummary> {
  const pending = await getPendingBatchShipments(db, batchId);
  if (!pending.length) throw new SchedulePickupError('nothing_pending', 'Nothing in this batch is waiting for labels.');

  // unpdf/pdf.js detaches the ArrayBuffer it's given after extracting text
  // (confirmed directly — not documented) — pdfBytes still needs to survive
  // for buildStampedOrderPdf below, so extraction gets its own copy.
  const pageTexts = await extractPageTexts(pdfBytes.slice());
  const candidates: MatchCandidate[] = pending.map((p) => ({ shipmentId: p.shipmentId, externalOrderId: p.externalOrderId, invoiceId: p.invoiceId }));
  const { matched, unmatched } = matchPagesToOrders(pageTexts, candidates);

  const matchedSummary: UploadedLabelSummary['matched'] = [];
  for (const p of pending) {
    const pageIndices = matched.get(p.shipmentId);
    if (!pageIndices?.length) continue;
    await finalizeMatchedShipment(db, p, pdfBytes, pageIndices);
    matchedSummary.push({ shipmentId: p.shipmentId, orderId: p.orderId, externalOrderId: p.externalOrderId, pageCount: pageIndices.length });
  }

  await logAudit(db, {
    userId,
    action: 'shipping.labels_uploaded',
    entityType: 'warehouse',
    entityId: warehouseId,
    metadata: { batchId, matched: matchedSummary.length, unmatchedPages: unmatched.length }
  });

  return { matched: matchedSummary, unmatchedPages: unmatched.map((idx) => ({ pageIndex: idx, snippet: (pageTexts[idx] ?? '').slice(0, 120) })) };
}

/** Manual fallback for pages processUploadedLabelPdf couldn't match on its own — admin picks the page(s) and the order by eye. */
export async function assignPageManually(
  db: D1Database,
  userId: string,
  warehouseId: string,
  batchId: string,
  orderId: string,
  pdfBytes: Uint8Array,
  pageIndices: number[]
): Promise<void> {
  if (!pageIndices.length) throw new SchedulePickupError('no_pages', 'Select at least one page');
  const pending = await getPendingBatchShipments(db, batchId);
  const target = pending.find((p) => p.orderId === orderId);
  if (!target) throw new SchedulePickupError('not_found', 'That order is not waiting for a label in this batch.');

  await finalizeMatchedShipment(db, target, pdfBytes, pageIndices);
  await logAudit(db, { userId, action: 'shipping.label_manually_assigned', entityType: 'order', entityId: orderId, metadata: { warehouseId, batchId, pageIndices } });
}

export function base64ToBytes(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}
