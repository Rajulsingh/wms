import { newId, logAudit } from './db';
import {
  getEligibleShippingServices,
  purchaseShipment,
  listHandoverSlots,
  scheduleEasyShipPackage,
  requestEasyShipDocuments,
  checkEasyShipFeed,
  checkEasyShipReport,
  type MfnShipmentRequest,
  type ShipFromAddress,
  type HandoverSlot
} from './amazon';
import { stampPackageIdentifier } from './label-stamp';
import { resolveAmazonCredentialsForWarehouse, NOT_CONNECTED } from './org-accounts';

function assertConnected<T>(credentials: T | typeof NOT_CONNECTED): T {
  if (credentials === NOT_CONNECTED) {
    throw new ShippingError('amazon_not_connected', 'Connect your Amazon account first (Settings → Connect Amazon) before shipping orders.');
  }
  return credentials;
}

export class ShippingError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

interface OrderForShipping {
  id: string;
  warehouse_id: string;
  external_order_id: string;
  source: string;
}

async function loadOrderAndBox(
  db: D1Database,
  orderId: string,
  boxSizeId: string
): Promise<{ order: OrderForShipping; lengthCm: number; widthCm: number; heightCm: number }> {
  const order = await db.prepare(`SELECT id, warehouse_id, external_order_id, source FROM orders WHERE id = ?`).bind(orderId).first<OrderForShipping>();
  if (!order) throw new ShippingError('not_found', 'Order not found');
  if (order.source !== 'amazon') {
    throw new ShippingError('not_amazon_order', 'Only Amazon-sourced orders can be shipped via Amazon — this order has no Amazon order id.');
  }

  const box = await db
    .prepare(`SELECT length, width, height, dimension_unit FROM box_sizes WHERE id = ? AND warehouse_id = ?`)
    .bind(boxSizeId, order.warehouse_id)
    .first<{ length: number; width: number; height: number; dimension_unit: string }>();
  if (!box) throw new ShippingError('box_not_found', 'Box size not found for this warehouse');

  const toCm = (v: number) => (box.dimension_unit === 'inches' ? v * 2.54 : v);
  return { order, lengthCm: toCm(box.length), widthCm: toCm(box.width), heightCm: toCm(box.height) };
}

// ============================================================================
// Easy Ship — the seller's actual shipping program (confirmed session 2, see
// amazon.ts). Two-step scheduling (list slots, then book one), followed by a
// separate async label-retrieval pipeline with no synchronous label response.
// ============================================================================

export async function getHandoverSlotsForOrder(db: D1Database, orderId: string, boxSizeId: string, weightGrams: number): Promise<HandoverSlot[]> {
  const { order, lengthCm, widthCm, heightCm } = await loadOrderAndBox(db, orderId, boxSizeId);
  const credentials = assertConnected(await resolveAmazonCredentialsForWarehouse(db, order.warehouse_id));
  return listHandoverSlots(
    order.external_order_id,
    { length: lengthCm, width: widthCm, height: heightCm, unit: 'cm' },
    { value: weightGrams, unit: 'grams' },
    credentials
  );
}

export interface ScheduleResult {
  shipmentId: string;
  packageId: string;
  trackingId?: string;
}

/**
 * Books the chosen handover slot — this is the point real commitment
 * happens (Amazon schedules a pickup). Creates the local package/shipment
 * rows immediately and kicks off (but does not wait for) label retrieval;
 * poll `checkLabelStatus` afterward from the UI, same pattern as the
 * picker/packer/admin auto-refresh polling elsewhere in this app.
 */
export async function scheduleEasyShipForOrder(
  db: D1Database,
  userId: string,
  orderId: string,
  boxSizeId: string,
  weightValue: number,
  weightUnit: string,
  slot: Pick<HandoverSlot, 'slotId' | 'startTime' | 'endTime' | 'handoverMethod'>,
  packageIdentifier: string
): Promise<ScheduleResult> {
  const { order } = await loadOrderAndBox(db, orderId, boxSizeId);
  const credentials = assertConnected(await resolveAmazonCredentialsForWarehouse(db, order.warehouse_id));

  const scheduled = await scheduleEasyShipPackage(order.external_order_id, slot, packageIdentifier, credentials);

  const packageId = newId();
  await db
    .prepare(`INSERT INTO packages (id, order_id, status, box_size_id, weight_value, weight_unit) VALUES (?, ?, 'labeled', ?, ?, ?)`)
    .bind(packageId, orderId, boxSizeId, weightValue, weightUnit)
    .run();

  const shipmentId = newId();
  await db
    .prepare(
      `INSERT INTO shipments (
         id, package_id, carrier, status, tracking_id, package_identifier,
         handover_slot_id, handover_slot_start, handover_slot_end, handover_method,
         scheduled_package_id, label_status
       ) VALUES (?, ?, 'amazon-easyship', 'label_applied', ?, ?, ?, ?, ?, ?, ?, 'not_requested')`
    )
    .bind(
      shipmentId,
      packageId,
      scheduled.trackingId ?? null,
      packageIdentifier,
      slot.slotId,
      slot.startTime,
      slot.endTime,
      slot.handoverMethod,
      scheduled.packageId
    )
    .run();

  await db
    .prepare(`INSERT INTO awbs (id, shipment_id, awb_code, scanned_at, verified) VALUES (?, ?, ?, datetime('now'), 1)`)
    .bind(newId(), shipmentId, scheduled.trackingId ?? scheduled.packageId)
    .run();

  await logAudit(db, { userId, action: 'shipping.easyship_scheduled', entityType: 'order', entityId: orderId, metadata: { packageId: scheduled.packageId, slot } });

  // Best-effort — scheduling already succeeded (a real commitment was made), so a
  // failure here shouldn't surface as a purchase failure. label_status stays
  // queryable and retryLabelRequest can re-kick this off.
  try {
    const { feedId } = await requestEasyShipDocuments(order.external_order_id, credentials);
    await db.prepare(`UPDATE shipments SET label_status = 'feed_submitted', label_feed_id = ? WHERE id = ?`).bind(feedId, shipmentId).run();
  } catch {
    await db.prepare(`UPDATE shipments SET label_status = 'failed' WHERE id = ?`).bind(shipmentId).run();
  }

  return { shipmentId, packageId: scheduled.packageId, trackingId: scheduled.trackingId };
}

export interface LabelStatusResult {
  labelStatus: string;
  labelBase64?: string;
  labelFileType?: string;
}

/** Advances label retrieval by exactly one step and returns current status — call from a poll loop, never a blocking wait (Amazon's processing time is unbounded from here). */
export async function checkLabelStatus(db: D1Database, shipmentId: string): Promise<LabelStatusResult> {
  const shipment = await db
    .prepare(
      `SELECT s.label_status, s.label_feed_id, s.label_report_id, s.label_base64, s.label_file_type, s.package_identifier, o.warehouse_id
       FROM shipments s JOIN packages p ON p.id = s.package_id JOIN orders o ON o.id = p.order_id WHERE s.id = ?`
    )
    .bind(shipmentId)
    .first<{
      label_status: string;
      label_feed_id: string | null;
      label_report_id: string | null;
      label_base64: string | null;
      label_file_type: string | null;
      package_identifier: string | null;
      warehouse_id: string;
    }>();
  if (!shipment) throw new ShippingError('not_found', 'Shipment not found');
  const credentials = assertConnected(await resolveAmazonCredentialsForWarehouse(db, shipment.warehouse_id));

  if (shipment.label_status === 'document_ready') {
    return { labelStatus: 'document_ready', labelBase64: shipment.label_base64 ?? undefined, labelFileType: shipment.label_file_type ?? undefined };
  }

  if (shipment.label_status === 'feed_submitted' && shipment.label_feed_id) {
    const feed = await checkEasyShipFeed(shipment.label_feed_id, credentials);
    if (feed.status === 'DONE' && feed.reportReferenceId) {
      await db.prepare(`UPDATE shipments SET label_status = 'report_ready', label_report_id = ? WHERE id = ?`).bind(feed.reportReferenceId, shipmentId).run();
      return { labelStatus: 'report_ready' };
    }
    if (feed.status === 'FATAL' || feed.status === 'CANCELLED') {
      await db.prepare(`UPDATE shipments SET label_status = 'failed' WHERE id = ?`).bind(shipmentId).run();
      throw new ShippingError('feed_failed', `Amazon's document feed ${feed.status.toLowerCase()} — try requesting the label again.`);
    }
    return { labelStatus: 'feed_submitted' };
  }

  if (shipment.label_status === 'report_ready' && shipment.label_report_id) {
    const report = await checkEasyShipReport(shipment.label_report_id, credentials);
    if (report.status === 'DONE' && report.labelBase64 && report.labelFileType) {
      const stamped = await stampPackageIdentifier(report.labelBase64, report.labelFileType, shipment.package_identifier ?? '');
      await db.prepare(`UPDATE shipments SET label_status = 'document_ready', label_base64 = ?, label_file_type = ? WHERE id = ?`).bind(stamped.base64, stamped.fileType, shipmentId).run();
      return { labelStatus: 'document_ready', labelBase64: stamped.base64, labelFileType: stamped.fileType };
    }
    if (report.status === 'FATAL' || report.status === 'CANCELLED') {
      await db.prepare(`UPDATE shipments SET label_status = 'failed' WHERE id = ?`).bind(shipmentId).run();
      throw new ShippingError('report_failed', `Amazon's report ${report.status.toLowerCase()} — try requesting the label again.`);
    }
    return { labelStatus: 'report_ready' };
  }

  return { labelStatus: shipment.label_status };
}

/** Retries label retrieval from scratch after a `failed` status — does not re-schedule the pickup, that already happened. */
export async function retryLabelRequest(db: D1Database, shipmentId: string): Promise<void> {
  const shipment = await db
    .prepare(`SELECT s.id, o.external_order_id, o.warehouse_id FROM shipments s JOIN packages p ON p.id = s.package_id JOIN orders o ON o.id = p.order_id WHERE s.id = ?`)
    .bind(shipmentId)
    .first<{ id: string; external_order_id: string; warehouse_id: string }>();
  if (!shipment) throw new ShippingError('not_found', 'Shipment not found');
  const credentials = assertConnected(await resolveAmazonCredentialsForWarehouse(db, shipment.warehouse_id));

  const { feedId } = await requestEasyShipDocuments(shipment.external_order_id, credentials);
  await db.prepare(`UPDATE shipments SET label_status = 'feed_submitted', label_feed_id = ?, label_report_id = NULL WHERE id = ?`).bind(feedId, shipmentId).run();
}

// ============================================================================
// MFN (Merchant Fulfillment Network) — left in place, fully working, but
// unused by the UI as of session 2 (the seller confirmed they ship via Easy
// Ship above, not MFN). Kept in case a non-EasyShip courier path is ever
// added; don't be surprised nothing calls these two functions anymore.
// ============================================================================

interface WarehouseShipFrom {
  ship_from_name: string | null;
  ship_from_address_line1: string | null;
  ship_from_city: string | null;
  ship_from_state: string | null;
  ship_from_postal_code: string | null;
  ship_from_country_code: string | null;
  ship_from_phone: string | null;
  ship_from_email: string | null;
}

async function getShipFromAddress(db: D1Database, warehouseId: string): Promise<ShipFromAddress> {
  const w = await db
    .prepare(
      `SELECT ship_from_name, ship_from_address_line1, ship_from_city, ship_from_state, ship_from_postal_code, ship_from_country_code, ship_from_phone, ship_from_email
       FROM warehouses WHERE id = ?`
    )
    .bind(warehouseId)
    .first<WarehouseShipFrom>();
  if (!w || !w.ship_from_name || !w.ship_from_address_line1 || !w.ship_from_city || !w.ship_from_postal_code || !w.ship_from_country_code || !w.ship_from_phone) {
    throw new ShippingError('ship_from_missing', 'This warehouse has no ship-from address set yet — add one in Settings before requesting a label.');
  }
  return {
    name: w.ship_from_name,
    addressLine1: w.ship_from_address_line1,
    city: w.ship_from_city,
    stateOrProvinceCode: w.ship_from_state ?? '',
    postalCode: w.ship_from_postal_code,
    countryCode: w.ship_from_country_code,
    phone: w.ship_from_phone,
    email: w.ship_from_email ?? undefined
  };
}

async function buildMfnShipmentRequest(
  db: D1Database,
  orderId: string,
  boxSizeId: string,
  weightValue: number,
  weightUnit: string
): Promise<{ request: MfnShipmentRequest; order: OrderForShipping }> {
  const order = await db.prepare(`SELECT id, warehouse_id, external_order_id, source FROM orders WHERE id = ?`).bind(orderId).first<OrderForShipping>();
  if (!order) throw new ShippingError('not_found', 'Order not found');
  if (order.source !== 'amazon') {
    throw new ShippingError('not_amazon_order', 'Only Amazon-sourced orders can get an Amazon-purchased label — this order has no Amazon order id to buy against.');
  }

  const items = await db
    .prepare(`SELECT amazon_order_item_id, quantity_ordered FROM order_items WHERE order_id = ? AND amazon_order_item_id IS NOT NULL`)
    .bind(orderId)
    .all<{ amazon_order_item_id: string; quantity_ordered: number }>();
  if (!items.results.length) {
    throw new ShippingError('no_items', 'This order has no line items with an Amazon order-item id — cannot request a label.');
  }

  const box = await db
    .prepare(`SELECT length, width, height, dimension_unit FROM box_sizes WHERE id = ? AND warehouse_id = ?`)
    .bind(boxSizeId, order.warehouse_id)
    .first<{ length: number; width: number; height: number; dimension_unit: string }>();
  if (!box) throw new ShippingError('box_not_found', 'Box size not found for this warehouse');

  const shipFrom = await getShipFromAddress(db, order.warehouse_id);

  const request: MfnShipmentRequest = {
    amazonOrderId: order.external_order_id,
    items: items.results.map((i) => ({ orderItemId: i.amazon_order_item_id, quantity: i.quantity_ordered })),
    shipFrom,
    dimensions: {
      length: box.length,
      width: box.width,
      height: box.height,
      unit: box.dimension_unit === 'inches' ? 'inches' : 'centimeters'
    },
    weight: { value: weightValue, unit: weightUnit as MfnShipmentRequest['weight']['unit'] }
  };
  return { request, order };
}

export interface RateOption {
  shippingServiceId: string;
  shippingServiceOfferId: string;
  carrierName: string;
  serviceName: string;
  rateAmount: number;
  rateCurrency: string;
}

export async function getRatesForOrder(db: D1Database, orderId: string, boxSizeId: string, weightValue: number, weightUnit: string): Promise<RateOption[]> {
  const { request, order } = await buildMfnShipmentRequest(db, orderId, boxSizeId, weightValue, weightUnit);
  const credentials = assertConnected(await resolveAmazonCredentialsForWarehouse(db, order.warehouse_id));
  const offers = await getEligibleShippingServices(request, credentials);
  return offers
    .filter((o) => !o.requiresAdditionalSellerInputs)
    .map((o) => ({
      shippingServiceId: o.shippingServiceId,
      shippingServiceOfferId: o.shippingServiceOfferId,
      carrierName: o.carrierName,
      serviceName: o.shippingServiceName,
      rateAmount: o.rateAmount,
      rateCurrency: o.rateCurrency
    }));
}

export interface PurchaseResult {
  packageId: string;
  shipmentId: string;
  trackingId: string;
  labelBase64: string;
  labelFileType: string;
}

export async function purchaseLabelForOrder(
  db: D1Database,
  userId: string,
  orderId: string,
  boxSizeId: string,
  weightValue: number,
  weightUnit: string,
  shippingServiceId: string,
  shippingServiceOfferId: string,
  packageIdentifier?: string
): Promise<PurchaseResult> {
  const { request, order } = await buildMfnShipmentRequest(db, orderId, boxSizeId, weightValue, weightUnit);
  const credentials = assertConnected(await resolveAmazonCredentialsForWarehouse(db, order.warehouse_id));
  const purchased = await purchaseShipment(request, shippingServiceId, shippingServiceOfferId, credentials);
  if (!purchased.labelBase64) throw new ShippingError('no_label', 'Amazon did not return a label in the purchase response');

  const stamped = await stampPackageIdentifier(purchased.labelBase64, purchased.labelFileType, packageIdentifier ?? order.external_order_id);
  purchased.labelBase64 = stamped.base64;
  purchased.labelFileType = stamped.fileType;

  const packageId = newId();
  await db
    .prepare(`INSERT INTO packages (id, order_id, status, box_size_id, weight_value, weight_unit) VALUES (?, ?, 'labeled', ?, ?, ?)`)
    .bind(packageId, orderId, boxSizeId, weightValue, weightUnit)
    .run();

  const shipmentId = newId();
  await db
    .prepare(
      `INSERT INTO shipments (id, package_id, carrier, status, carrier_service_id, carrier_service_name, amazon_shipment_id, tracking_id, label_base64, label_file_type, package_identifier)
       VALUES (?, ?, ?, 'label_applied', ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      shipmentId,
      packageId,
      'amazon-mfn',
      shippingServiceId,
      shippingServiceId,
      purchased.amazonShipmentId,
      purchased.trackingId,
      purchased.labelBase64,
      purchased.labelFileType,
      packageIdentifier ?? order.external_order_id
    )
    .run();

  await db
    .prepare(`INSERT INTO awbs (id, shipment_id, awb_code, scanned_at, verified) VALUES (?, ?, ?, datetime('now'), 1)`)
    .bind(newId(), shipmentId, purchased.trackingId)
    .run();

  await logAudit(db, { userId, action: 'shipping.label_purchased', entityType: 'order', entityId: orderId, metadata: { trackingId: purchased.trackingId } });

  return { packageId, shipmentId, trackingId: purchased.trackingId, labelBase64: purchased.labelBase64, labelFileType: purchased.labelFileType };
}

// ============================================================================
// Bulk Easy Ship scheduling — schedule several orders in one call via
// createScheduledPackageBulk. Better fit than looping the single-order flow:
// the bulk response includes a ready-to-download ZIP of every label
// synchronously (no Feeds/Reports polling per order). See amazon.ts.
// ============================================================================

export interface BulkScheduleOrderInput {
  orderId: string;
  boxSizeId: string;
  weightValue: number;
  packageIdentifier: string;
}

export interface BulkScheduleOutcome {
  orderId: string;
  externalOrderId: string;
  ok: boolean;
  shipmentId?: string;
  trackingId?: string;
  error?: string;
}

export interface BulkScheduleSummary {
  outcomes: BulkScheduleOutcome[];
  labelSplitOk: boolean; // whether the ZIP was cleanly split into one stamped PDF per order
}

/**
 * Schedules multiple orders in one Easy Ship call. All orders share one
 * handover slot (chosen against one representative order — in practice
 * pickup windows are a warehouse-level schedule, not really per-order) but
 * each keeps its own box size, weight, and package identifier.
 *
 * Label handling is best-effort: attempts to unzip `printableDocumentsUrl`
 * (fflate) and match PDF entries 1:1 with the orders in request order,
 * stamping each with its package identifier. That positional mapping is an
 * assumption, not confirmed against a real response — if the entry count
 * doesn't match the scheduled-order count, every scheduled shipment falls
 * back to sharing the raw, unstamped ZIP instead of silently mis-assigning
 * labels. Verify the real ZIP structure the first time this runs live.
 */
export async function scheduleEasyShipBulk(
  db: D1Database,
  userId: string,
  orders: BulkScheduleOrderInput[],
  slot?: Pick<HandoverSlot, 'slotId' | 'startTime' | 'endTime' | 'handoverMethod'>
): Promise<BulkScheduleSummary> {
  if (!orders.length) throw new ShippingError('no_orders', 'Select at least one order');

  const loaded: Array<{ input: BulkScheduleOrderInput; order: OrderForShipping }> = [];
  for (const input of orders) {
    const { order } = await loadOrderAndBox(db, input.orderId, input.boxSizeId);
    loaded.push({ input, order });
  }

  const { createScheduledPackageBulk } = await import('./amazon');
  // All orders in one bulk call are assumed to belong to the same warehouse
  // (the admin UI only ever offers orders from the session's own warehouse) —
  // resolving credentials once from the first order is correct for that case.
  const credentials = assertConnected(await resolveAmazonCredentialsForWarehouse(db, loaded[0].order.warehouse_id));
  const bulkResult = await createScheduledPackageBulk(
    loaded.map(({ input, order }) => ({
      amazonOrderId: order.external_order_id,
      packageIdentifier: input.packageIdentifier,
      packageTimeSlot: slot
    })),
    credentials
  );

  // Create local package/shipment rows for everything Amazon actually scheduled.
  const created: Array<{ orderId: string; externalOrderId: string; shipmentId: string; packageIdentifier: string; trackingId?: string }> = [];
  for (const { input, order } of loaded) {
    const scheduled = bulkResult.scheduled.find((s) => s.amazonOrderId === order.external_order_id);
    if (!scheduled) continue; // rejected — handled below

    const packageId = newId();
    await db
      .prepare(`INSERT INTO packages (id, order_id, status, box_size_id, weight_value, weight_unit) VALUES (?, ?, 'labeled', ?, ?, 'grams')`)
      .bind(packageId, input.orderId, input.boxSizeId, input.weightValue)
      .run();

    const shipmentId = newId();
    await db
      .prepare(
        `INSERT INTO shipments (
           id, package_id, carrier, status, tracking_id, package_identifier,
           handover_slot_id, handover_slot_start, handover_slot_end, handover_method,
           scheduled_package_id, label_status
         ) VALUES (?, ?, 'amazon-easyship', 'label_applied', ?, ?, ?, ?, ?, ?, ?, 'not_requested')`
      )
      .bind(
        shipmentId,
        packageId,
        scheduled.trackingId ?? null,
        input.packageIdentifier,
        slot?.slotId ?? null,
        slot?.startTime ?? null,
        slot?.endTime ?? null,
        slot?.handoverMethod ?? null,
        scheduled.packageId
      )
      .run();

    await db
      .prepare(`INSERT INTO awbs (id, shipment_id, awb_code, scanned_at, verified) VALUES (?, ?, ?, datetime('now'), 1)`)
      .bind(newId(), shipmentId, scheduled.trackingId ?? scheduled.packageId)
      .run();

    created.push({ orderId: input.orderId, externalOrderId: order.external_order_id, shipmentId, packageIdentifier: input.packageIdentifier, trackingId: scheduled.trackingId });
  }

  await logAudit(db, {
    userId,
    action: 'shipping.easyship_bulk_scheduled',
    metadata: { scheduled: bulkResult.scheduled.map((s) => s.amazonOrderId), rejected: bulkResult.rejected }
  });

  // Try to fetch + split the label ZIP. Best-effort — scheduling already succeeded
  // (real commitments made) regardless of whether this part works.
  let labelSplitOk = false;
  if (bulkResult.printableDocumentsUrl && created.length) {
    try {
      const zipRes = await fetch(bulkResult.printableDocumentsUrl);
      if (zipRes.ok) {
        const zipBytes = new Uint8Array(await zipRes.arrayBuffer());
        const { unzipSync } = await import('fflate');
        const entries = unzipSync(zipBytes);
        const pdfEntries = Object.entries(entries).filter(([name]) => /\.pdf$/i.test(name));

        if (pdfEntries.length === created.length) {
          // Positional mapping assumption — see doc comment above.
          for (let i = 0; i < created.length; i++) {
            const [, bytes] = pdfEntries[i];
            let binary = '';
            for (let j = 0; j < bytes.length; j++) binary += String.fromCharCode(bytes[j]);
            const stamped = await stampPackageIdentifier(btoa(binary), 'application/pdf', created[i].packageIdentifier);
            await db
              .prepare(`UPDATE shipments SET label_status = 'document_ready', label_base64 = ?, label_file_type = ? WHERE id = ?`)
              .bind(stamped.base64, stamped.fileType, created[i].shipmentId)
              .run();
          }
          labelSplitOk = true;
        } else {
          // Entry count didn't match — share the raw zip rather than guess at mapping.
          let binary = '';
          for (let j = 0; j < zipBytes.length; j++) binary += String.fromCharCode(zipBytes[j]);
          const zipBase64 = btoa(binary);
          for (const c of created) {
            await db
              .prepare(`UPDATE shipments SET label_status = 'document_ready', label_base64 = ?, label_file_type = 'application/zip' WHERE id = ?`)
              .bind(zipBase64, c.shipmentId)
              .run();
          }
        }
      }
    } catch {
      for (const c of created) {
        await db.prepare(`UPDATE shipments SET label_status = 'failed' WHERE id = ?`).bind(c.shipmentId).run();
      }
    }
  }

  const outcomes: BulkScheduleOutcome[] = loaded.map(({ input, order }) => {
    const ok = created.find((c) => c.orderId === input.orderId);
    if (ok) return { orderId: input.orderId, externalOrderId: order.external_order_id, ok: true, shipmentId: ok.shipmentId, trackingId: ok.trackingId };
    const rejected = bulkResult.rejected.find((r) => r.amazonOrderId === order.external_order_id);
    return { orderId: input.orderId, externalOrderId: order.external_order_id, ok: false, error: rejected?.message ?? 'Not scheduled' };
  });

  return { outcomes, labelSplitOk };
}
