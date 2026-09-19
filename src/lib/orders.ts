import { newId } from './db';
import { reserveInventory, InsufficientStockError } from './inventory';
import { fetchCatalogItemDetails, type AmazonOrder } from './amazon';
import { resolveSkuIdByCode } from './skus';

export interface ImportSummary {
  imported: number;
  skipped: number;
  newSkusCreated: string[];
}

/**
 * Upserts Amazon orders + items. Does NOT reserve inventory yet — that
 * happens at batch creation (§5/§11), so an order sitting in the queue
 * doesn't lock stock other orders could still use.
 *
 * A SellerSKU we haven't seen before is created on the fly from Amazon's own
 * catalog data (real title + main image via Catalog Items, not a placeholder)
 * rather than silently dropping the line item — it just starts with zero
 * inventory until receiving/admin records real stock for it.
 */
export async function importAmazonOrders(db: D1Database, warehouseId: string, orders: AmazonOrder[]): Promise<ImportSummary> {
  const summary: ImportSummary = { imported: 0, skipped: 0, newSkusCreated: [] };

  for (const order of orders) {
    const existing = await db
      .prepare(`SELECT id FROM orders WHERE warehouse_id = ? AND source = 'amazon' AND external_order_id = ?`)
      .bind(warehouseId, order.amazonOrderId)
      .first<{ id: string }>();
    if (existing) {
      summary.skipped++;
      continue;
    }

    const orderId = newId();
    await db
      .prepare(
        `INSERT INTO orders (id, warehouse_id, external_order_id, source, status, ship_by, customer_name, shipping_address)
         VALUES (?, ?, ?, 'amazon', 'pending', ?, ?, ?)`
      )
      .bind(orderId, warehouseId, order.amazonOrderId, order.earliestShipDate ?? null, order.buyerName ?? null, order.shippingAddress ?? null)
      .run();

    for (const item of order.items) {
      // Follows a merge redirect if this SellerSKU used to be a duplicate
      // that's since been merged into another SKU — otherwise the same
      // SellerSKU showing up again would spawn a second empty duplicate
      // every time, right back where the merge started. See lib/skus.ts.
      let skuId = await resolveSkuIdByCode(db, item.sellerSku);
      if (!skuId) {
        const catalog = item.asin ? await fetchCatalogItemDetails(item.asin) : { title: null, imageUrl: null };
        skuId = newId();
        await db
          .prepare(`INSERT INTO skus (id, sku_code, name, image_url) VALUES (?, ?, ?, ?)`)
          .bind(skuId, item.sellerSku, catalog.title ?? item.title ?? item.sellerSku, catalog.imageUrl)
          .run();
        summary.newSkusCreated.push(item.sellerSku);
      }
      await db
        .prepare(`INSERT INTO order_items (id, order_id, sku_id, quantity_ordered, amazon_order_item_id) VALUES (?, ?, ?, ?, ?)`)
        .bind(newId(), orderId, skuId, item.quantityOrdered, item.orderItemId)
        .run();
    }

    summary.imported++;
  }

  return summary;
}

export interface CreateBatchResult {
  batchId: string;
  orderCount: number;
  taskCount: number;
  shortOrders: Array<{ orderId: string; skuId: string; reason: string }>;
}

/**
 * MVP batching (§11: "simple wave: all open orders at generation time,
 * capped by cart capacity"). Reserves inventory per order item as it's added
 * to the batch — an order that can't be fully reserved is left out of this
 * batch entirely (not partially reserved) so it doesn't hold units hostage;
 * it stays "pending" and is picked up by the next batch run.
 */
export async function createPickBatch(
  db: D1Database,
  warehouseId: string,
  opts: { maxOrders: number; cartId: string }
): Promise<CreateBatchResult> {
  const openOrders = await db
    .prepare(
      `SELECT id FROM orders WHERE warehouse_id = ? AND status IN ('pending', 'allocated') ORDER BY priority DESC, created_at ASC LIMIT ?`
    )
    .bind(warehouseId, opts.maxOrders)
    .all<{ id: string }>();

  if (!openOrders.results.length) {
    return { batchId: '', orderCount: 0, taskCount: 0, shortOrders: [] };
  }

  const batchId = newId();
  const shortOrders: CreateBatchResult['shortOrders'] = [];
  let includedOrderCount = 0;
  let taskCount = 0;
  let slotNumber = 0;

  await db
    .prepare(`INSERT INTO pick_batches (id, warehouse_id, cart_id, status) VALUES (?, ?, ?, 'pending')`)
    .bind(batchId, warehouseId, opts.cartId)
    .run();

  for (const order of openOrders.results) {
    const items = await db
      .prepare(`SELECT id, sku_id, quantity_ordered FROM order_items WHERE order_id = ? AND status = 'pending'`)
      .bind(order.id)
      .all<{ id: string; sku_id: string; quantity_ordered: number }>();
    if (!items.results.length) continue;

    // Reserve everything for this order first; roll back the order's own reservations if any item comes up short.
    const orderReservations: Array<{ inventoryId: string; locationId: string; quantity: number; orderItemId: string; skuId: string }> = [];
    let orderOk = true;

    for (const item of items.results) {
      try {
        const claims = await reserveInventory(db, item.sku_id, warehouseId, item.quantity_ordered);
        for (const claim of claims) {
          orderReservations.push({ ...claim, orderItemId: item.id, skuId: item.sku_id });
        }
      } catch (err) {
        if (err instanceof InsufficientStockError) {
          const sku = await db.prepare(`SELECT sku_code FROM skus WHERE id = ?`).bind(item.sku_id).first<{ sku_code: string }>();
          const orderRow = await db.prepare(`SELECT external_order_id FROM orders WHERE id = ?`).bind(order.id).first<{ external_order_id: string }>();
          shortOrders.push({
            orderId: order.id,
            skuId: item.sku_id,
            reason: `${orderRow?.external_order_id ?? order.id}: needs ${err.requested} of ${sku?.sku_code ?? item.sku_id}, only ${err.available} in stock`
          });
          orderOk = false;
          break;
        }
        throw err;
      }
    }

    if (!orderOk) {
      const { releaseReservation } = await import('./inventory');
      for (const r of orderReservations) await releaseReservation(db, r.inventoryId, r.quantity);
      continue;
    }

    // From here, any failure (a constraint error, anything unexpected) must not
    // crash the whole batch: it must release this order's reservations and
    // move on, the same as a stock shortfall — otherwise a single bad order
    // leaves leaked reservations and an inconsistent batch for everyone else in it.
    let cartSlotId: string | undefined;
    let insertedTasksThisOrder = 0;
    try {
      cartSlotId = newId();
      await db
        .prepare(`INSERT INTO cart_slots (id, cart_id, pick_batch_id, slot_number, order_id) VALUES (?, ?, ?, ?, ?)`)
        .bind(cartSlotId, opts.cartId, batchId, slotNumber++, order.id)
        .run();

      for (const r of orderReservations) {
        const location = await db
          .prepare(`SELECT sequence_number FROM locations WHERE id = ?`)
          .bind(r.locationId)
          .first<{ sequence_number: number }>();
        await db
          .prepare(
            `INSERT INTO pick_tasks (id, pick_batch_id, order_item_id, sku_id, location_id, cart_slot_id, quantity_required, sequence_number, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
          )
          .bind(newId(), batchId, r.orderItemId, r.skuId, r.locationId, cartSlotId, r.quantity, location?.sequence_number ?? 0)
          .run();
        taskCount++;
        insertedTasksThisOrder++;
      }

      await db.prepare(`UPDATE orders SET status = 'batched' WHERE id = ?`).bind(order.id).run();
      includedOrderCount++;
    } catch (err) {
      const { releaseReservation } = await import('./inventory');
      for (const r of orderReservations) await releaseReservation(db, r.inventoryId, r.quantity);
      taskCount -= insertedTasksThisOrder;
      if (cartSlotId) {
        await db.prepare(`DELETE FROM pick_tasks WHERE cart_slot_id = ?`).bind(cartSlotId).run();
        await db.prepare(`DELETE FROM cart_slots WHERE id = ?`).bind(cartSlotId).run();
      }
      shortOrders.push({ orderId: order.id, skuId: '', reason: `Batch write failed: ${(err as Error).message}` });
    }
  }

  if (includedOrderCount === 0) {
    await db.prepare(`DELETE FROM pick_batches WHERE id = ?`).bind(batchId).run();
    return { batchId: '', orderCount: 0, taskCount: 0, shortOrders };
  }

  return { batchId, orderCount: includedOrderCount, taskCount, shortOrders };
}

