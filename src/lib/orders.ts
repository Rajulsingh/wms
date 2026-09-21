import { newId } from './db';
import { reserveInventory, releaseReservation, InsufficientStockError } from './inventory';
import { fetchCatalogItemDetails, type AmazonOrder, type AmazonEnv } from './amazon';
import { resolveSkuIdByCode } from './skus';
import { mapWithConcurrency } from './concurrency';
import { getOrganizationIdForWarehouse } from './org-accounts';

export interface ImportSummary {
  imported: number;
  skipped: number;
  newSkusCreated: string[];
  shortOrders: Array<{ orderId: string; reason: string }>;
}

/**
 * Upserts Amazon orders + items, then reserves inventory for each newly
 * imported order immediately (see `reserveOrderForPicking`) — stock locks
 * the moment an order lands, not whenever a picker happens to next poll.
 *
 * A SellerSKU we haven't seen before is created on the fly from Amazon's own
 * catalog data (real title + main image via Catalog Items, not a placeholder)
 * rather than silently dropping the line item — it just starts with zero
 * inventory until receiving/admin records real stock for it.
 *
 * Orders are independent of each other (this order's rows never depend on
 * that one's), so they're processed with bounded concurrency instead of one
 * at a time — a sync pulling in 20+ new orders used to pay each one's full
 * DB round-trip latency back to back. The one place two orders *can*
 * genuinely collide is both containing the very same brand-new SellerSKU —
 * handled with `ON CONFLICT ... DO NOTHING` + re-resolve rather than a bare
 * INSERT, so whichever order loses that race reuses the SKU row the other
 * one just created instead of erroring on the sku_code UNIQUE constraint.
 * `reserveOrderForPicking`'s own inventory claims already use optimistic
 * (version-column) concurrency control, so two orders competing for the
 * same SKU's stock resolve correctly (one wins, the other gets a real
 * insufficient-stock result) rather than double-booking.
 */
export async function importAmazonOrders(db: D1Database, warehouseId: string, orders: AmazonOrder[], credentials?: Partial<AmazonEnv>): Promise<ImportSummary> {
  const summary: ImportSummary = { imported: 0, skipped: 0, newSkusCreated: [], shortOrders: [] };
  const organizationId = await getOrganizationIdForWarehouse(db, warehouseId);

  await mapWithConcurrency(orders, 5, async (order) => {
    const existing = await db
      .prepare(`SELECT id FROM orders WHERE warehouse_id = ? AND source = 'amazon' AND external_order_id = ?`)
      .bind(warehouseId, order.amazonOrderId)
      .first<{ id: string }>();
    if (existing) {
      summary.skipped++;
      return;
    }

    const orderId = newId();
    await db
      .prepare(
        `INSERT INTO orders (id, warehouse_id, external_order_id, source, status, ship_by, customer_name, shipping_address, amazon_order_status)
         VALUES (?, ?, ?, 'amazon', 'pending', ?, ?, ?, ?)`
      )
      .bind(
        orderId,
        warehouseId,
        order.amazonOrderId,
        order.latestShipDate ?? order.earliestShipDate ?? null,
        order.buyerName ?? null,
        order.shippingAddress ?? null,
        order.orderStatus
      )
      .run();

    for (const item of order.items) {
      // Follows a merge redirect if this SellerSKU used to be a duplicate
      // that's since been merged into another SKU — otherwise the same
      // SellerSKU showing up again would spawn a second empty duplicate
      // every time, right back where the merge started. See lib/skus.ts.
      let skuId = await resolveSkuIdByCode(db, organizationId, item.sellerSku);
      if (!skuId) {
        const catalog = item.asin ? await fetchCatalogItemDetails(item.asin, credentials) : { title: null, imageUrl: null };
        const candidateId = newId();
        // ON CONFLICT still targets the plain sku_code UNIQUE constraint
        // (not (organization_id, sku_code) — that composite constraint
        // doesn't exist yet, see migrations/0026_skus_per_organization.sql
        // for why the table rebuild needed for it was deferred). Means two
        // different orgs sharing the exact same SellerSKU string would still
        // collide here — a known, documented, low-probability follow-up,
        // not the leak this organization_id column exists to close.
        await db
          .prepare(`INSERT INTO skus (id, organization_id, sku_code, name, image_url, asin) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (sku_code) DO NOTHING`)
          .bind(candidateId, organizationId, item.sellerSku, catalog.title ?? item.title ?? item.sellerSku, catalog.imageUrl, item.asin ?? null)
          .run();
        // Re-resolve regardless of who won — a concurrently-processed order
        // with the same brand-new SellerSKU may have created it first, in
        // which case the INSERT above was a no-op and this returns *their*
        // id, not candidateId.
        skuId = await resolveSkuIdByCode(db, organizationId, item.sellerSku);
        if (skuId === candidateId) summary.newSkusCreated.push(item.sellerSku);
      }
      await db
        .prepare(`INSERT INTO order_items (id, order_id, sku_id, quantity_ordered, amazon_order_item_id) VALUES (?, ?, ?, ?, ?)`)
        .bind(newId(), orderId, skuId, item.quantityOrdered, item.orderItemId)
        .run();
    }

    summary.imported++;
    const reserved = await reserveOrderForPicking(db, warehouseId, orderId);
    if (!reserved.reserved && reserved.reason) summary.shortOrders.push({ orderId, reason: reserved.reason });
  });

  return summary;
}

export interface UnbatchedOrderSummary {
  orderCount: number;
  skuCount: number;
  unitCount: number;
}

/**
 * Orders sitting open with an unreserved item, right now — since
 * `reserveOrderForPicking` runs immediately at import/creation, an order
 * only ever lands here when that reservation actually failed (insufficient
 * stock) or hasn't happened yet for some other reason. Shown on the packer
 * dashboard as "blocked" — visibility only, not a claim action. See
 * HANDOFF.md.
 */
export async function getUnbatchedOrderSummary(db: D1Database, warehouseId: string): Promise<UnbatchedOrderSummary> {
  const rows = await db
    .prepare(
      `SELECT oi.sku_id, oi.quantity_ordered, o.id AS order_id
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
       WHERE o.warehouse_id = ? AND o.status IN ('pending', 'allocated') AND oi.status = 'pending'`
    )
    .bind(warehouseId)
    .all<{ sku_id: string; quantity_ordered: number; order_id: string }>();

  return {
    orderCount: new Set(rows.results.map((r) => r.order_id)).size,
    skuCount: new Set(rows.results.map((r) => r.sku_id)).size,
    unitCount: rows.results.reduce((sum, r) => sum + r.quantity_ordered, 0)
  };
}

export interface ReserveOrderResult {
  reserved: boolean;
  batchId?: string;
  taskCount: number;
  reason?: string;
  // Set (never alongside `reason`) when the only thing blocking reservation
  // is that the order isn't due to ship yet — see isDueForPickingToday
  // below. Distinguished from `reason` so callers (importAmazonOrders,
  // retryBlockedOrders) don't lump "scheduled for a later day, working as
  // intended" in with genuine stock-shortage "blocked" noise.
  notDueYet?: boolean;
  // Same idea, for an order Amazon hasn't confirmed yet (see
  // amazon_order_status below) — held back even if its ship-by date is
  // today, since Amazon could still cancel it before ever confirming it.
  stillPending?: boolean;
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * A pick list should only ever contain orders actually going out today — a
 * user request after finding a same-day-scheduled Easy Ship order already
 * sitting in the active pick pool days before its real ship-by date (see
 * HANDOFF.md). `shipBy` is UTC (Amazon's `LatestShipDate`/`EarliestShipDate`,
 * see amazon.ts); this seller's warehouse is India-based (same assumption
 * the cron trigger already hardcodes), so "today" means the IST calendar
 * day, not the UTC one — shifting both timestamps by the same fixed offset
 * before comparing dates is enough to get that right without a timezone
 * library. `null` (manual/CSV orders with no known ship-by date) is always
 * due — there's no date to defer to, so gating it would just leave it
 * stuck forever.
 */
function isDueForPickingToday(shipBy: string | null): boolean {
  if (!shipBy) return true;
  const shipByIstDate = new Date(new Date(shipBy).getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
  const todayIstDate = new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
  return shipByIstDate <= todayIstDate;
}

/**
 * Reserves inventory for one order's items and generates its pick_tasks,
 * called immediately at import/creation (not deferred to claim time) — so
 * stock locks and shortages surface the moment an order lands, not whenever
 * a picker next happens to poll. All-or-nothing per order: if any item comes
 * up short, everything already reserved for this order is rolled back and
 * it's left `'pending'` untouched, to be retried later (see the retry hook
 * in inbound.ts's receiveStock, and picker.ts's self-healing fallback).
 *
 * Also gated on `isDueForPickingToday` — an order isn't reserved (no stock
 * locked, no pick_batch created) until its ship-by day actually arrives, so
 * the same retry machinery that re-attempts a stock-blocked order (the cron
 * job's retryBlockedOrders, every 5 minutes during warehouse hours) is what
 * naturally picks it up once it's due, with no separate scheduler needed.
 *
 * Also gated on `amazon_order_status !== 'Pending'` — a user request after
 * finding a genuinely same-day order still sitting Amazon-side "Pending"
 * (payment/address/fraud check not yet done, could still be cancelled
 * outright before Amazon ever confirms it) already batched and in the
 * active pick list (see HANDOFF.md). `syncOrderStatuses` (amazon-sync.ts)
 * keeps this column current on every poll and runs right before
 * retryBlockedOrders in the same cron cycle, so an order held back here
 * becomes reservable the moment Amazon confirms it (flips to Unshipped/
 * PartiallyShipped) without any separate scheduler.
 *
 * Creates exactly one `pick_batches` row per order (no `cart_id`/cart_slots
 * — there's no multi-order sweep to bundle here) rather than removing the
 * pick_batches/pack_sessions machinery outright: every function scoped by
 * `pick_batch_id` (claim/assign, completion checks, packing, labeling)
 * already operates correctly per batch, so a batch that's always exactly
 * one order makes all of that correct per order for free. See HANDOFF.md.
 */
export async function reserveOrderForPicking(db: D1Database, warehouseId: string, orderId: string): Promise<ReserveOrderResult> {
  const orderRow = await db
    .prepare(`SELECT ship_by, amazon_order_status FROM orders WHERE id = ?`)
    .bind(orderId)
    .first<{ ship_by: string | null; amazon_order_status: string | null }>();
  if (orderRow?.amazon_order_status === 'Pending') {
    return { reserved: false, taskCount: 0, stillPending: true };
  }
  if (orderRow && !isDueForPickingToday(orderRow.ship_by)) {
    return { reserved: false, taskCount: 0, notDueYet: true };
  }

  const items = await db
    .prepare(`SELECT id, sku_id, quantity_ordered FROM order_items WHERE order_id = ? AND status = 'pending'`)
    .bind(orderId)
    .all<{ id: string; sku_id: string; quantity_ordered: number }>();
  if (!items.results.length) {
    // Distinguished from a real stock shortage on purpose — this is a data-
    // state issue (the order claims to be pending but its own items say
    // otherwise, e.g. from the reset race a real incident traced to — see
    // reset.ts), not something "receive stock" fixes. A genuinely empty
    // order (no line items at all) gets its own message rather than being
    // lumped in as the same "already processed" case.
    const totalItems = await db.prepare(`SELECT COUNT(*) as c FROM order_items WHERE order_id = ?`).bind(orderId).first<{ c: number }>();
    const reason = totalItems?.c
      ? `This order's items are already marked processed, not pending — not a stock issue. Check Exceptions or ask for help.`
      : 'This order has no line items at all.';
    return { reserved: false, taskCount: 0, reason };
  }

  const orderReservations: Array<{ inventoryId: string; locationId: string; quantity: number; orderItemId: string; skuId: string }> = [];

  for (const item of items.results) {
    try {
      const claims = await reserveInventory(db, item.sku_id, warehouseId, item.quantity_ordered);
      for (const claim of claims) orderReservations.push({ ...claim, orderItemId: item.id, skuId: item.sku_id });
    } catch (err) {
      if (err instanceof InsufficientStockError) {
        for (const r of orderReservations) await releaseReservation(db, r.inventoryId, r.quantity);
        const sku = await db.prepare(`SELECT sku_code FROM skus WHERE id = ?`).bind(item.sku_id).first<{ sku_code: string }>();
        const orderRow = await db.prepare(`SELECT external_order_id FROM orders WHERE id = ?`).bind(orderId).first<{ external_order_id: string }>();
        return {
          reserved: false,
          taskCount: 0,
          reason: `${orderRow?.external_order_id ?? orderId}: needs ${err.requested} of ${sku?.sku_code ?? item.sku_id}, only ${err.available} in stock`
        };
      }
      throw err;
    }
  }

  const batchId = newId();
  let taskCount = 0;
  try {
    await db.prepare(`INSERT INTO pick_batches (id, warehouse_id, status) VALUES (?, ?, 'pending')`).bind(batchId, warehouseId).run();
    for (const r of orderReservations) {
      const location = await db
        .prepare(`SELECT sequence_number FROM locations WHERE id = ?`)
        .bind(r.locationId)
        .first<{ sequence_number: number }>();
      await db
        .prepare(
          `INSERT INTO pick_tasks (id, pick_batch_id, order_item_id, sku_id, location_id, quantity_required, sequence_number, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`
        )
        .bind(newId(), batchId, r.orderItemId, r.skuId, r.locationId, r.quantity, location?.sequence_number ?? 0)
        .run();
      taskCount++;
    }
    await db.prepare(`UPDATE orders SET status = 'batched' WHERE id = ?`).bind(orderId).run();
  } catch (err) {
    // Same defensive rollback as a stock shortfall — a write failure here
    // must not leave leaked reservations or an orphaned pick_batches row.
    for (const r of orderReservations) await releaseReservation(db, r.inventoryId, r.quantity);
    await db.prepare(`DELETE FROM pick_tasks WHERE pick_batch_id = ?`).bind(batchId).run();
    await db.prepare(`DELETE FROM pick_batches WHERE id = ?`).bind(batchId).run();
    return { reserved: false, taskCount: 0, reason: `Reservation write failed: ${(err as Error).message}` };
  }

  return { reserved: true, batchId, taskCount };
}

export interface RetryBlockedOrdersResult {
  retried: number;
  succeeded: number;
  shortOrders: Array<{ orderId: string; reason: string }>;
}

/**
 * Retries `reserveOrderForPicking` for every currently-blocked order in the
 * warehouse (oldest first) — orders that failed reservation at import time,
 * almost always for insufficient stock. Admin-triggered manual nudge after
 * fixing stock, on top of the automatic retry in inbound.ts's receiveStock.
 * See HANDOFF.md.
 */
export async function retryBlockedOrders(db: D1Database, warehouseId: string): Promise<RetryBlockedOrdersResult> {
  const blocked = await db
    .prepare(`SELECT id FROM orders WHERE warehouse_id = ? AND status IN ('pending', 'allocated') ORDER BY priority DESC, created_at ASC`)
    .bind(warehouseId)
    .all<{ id: string }>();

  const result: RetryBlockedOrdersResult = { retried: 0, succeeded: 0, shortOrders: [] };
  for (const order of blocked.results) {
    result.retried++;
    const reserved = await reserveOrderForPicking(db, warehouseId, order.id);
    if (reserved.reserved) {
      result.succeeded++;
    } else if (reserved.reason) {
      result.shortOrders.push({ orderId: order.id, reason: reserved.reason });
    }
  }
  return result;
}

/**
 * Same retry, scoped to orders needing one specific SKU — called right after
 * `receiveStock` increases that SKU's on-hand quantity, so an order blocked
 * on it resolves the moment stock arrives instead of waiting for a picker's
 * poll or an admin's manual retry. See HANDOFF.md.
 */
export async function retryBlockedOrdersForSku(db: D1Database, warehouseId: string, skuId: string): Promise<RetryBlockedOrdersResult> {
  const blocked = await db
    .prepare(
      `SELECT DISTINCT o.id FROM orders o JOIN order_items oi ON oi.order_id = o.id
       WHERE o.warehouse_id = ? AND o.status IN ('pending', 'allocated') AND oi.sku_id = ?
       ORDER BY o.priority DESC, o.created_at ASC`
    )
    .bind(warehouseId, skuId)
    .all<{ id: string }>();

  const result: RetryBlockedOrdersResult = { retried: 0, succeeded: 0, shortOrders: [] };
  for (const order of blocked.results) {
    result.retried++;
    const reserved = await reserveOrderForPicking(db, warehouseId, order.id);
    if (reserved.reserved) {
      result.succeeded++;
    } else if (reserved.reason) {
      result.shortOrders.push({ orderId: order.id, reason: reserved.reason });
    }
  }
  return result;
}

