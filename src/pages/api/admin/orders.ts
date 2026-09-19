import type { APIRoute } from 'astro';
import { getDb, logAudit, newId } from '../../../lib/db';
import { requireUser, AuthError } from '../../../lib/auth';
import { autoBatchNewOrders } from '../../../lib/orders';

/** Manual order entry / CSV-row-at-a-time import (§11 MVP: "manual + CSV/API"). One order per call; a CSV upload UI can call this in a loop. */
export const POST: APIRoute = async (context) => {
  const db = getDb();
  try {
    const user = await requireUser(context, db, ['admin']);
    const body = await context.request.json<{
      warehouseId: string;
      externalOrderId: string;
      customerName?: string;
      shippingAddress?: string;
      priority?: number;
      items: Array<{ skuCode: string; quantity: number }>;
    }>();

    const orderId = newId();
    await db
      .prepare(
        `INSERT INTO orders (id, warehouse_id, external_order_id, source, status, priority, customer_name, shipping_address)
         VALUES (?, ?, ?, 'manual', 'pending', ?, ?, ?)`
      )
      .bind(orderId, body.warehouseId, body.externalOrderId, body.priority ?? 0, body.customerName ?? null, body.shippingAddress ?? null)
      .run();

    const unmatchedSkus: string[] = [];
    for (const item of body.items) {
      const sku = await db.prepare(`SELECT id FROM skus WHERE sku_code = ?`).bind(item.skuCode).first<{ id: string }>();
      if (!sku) {
        unmatchedSkus.push(item.skuCode);
        continue;
      }
      await db
        .prepare(`INSERT INTO order_items (id, order_id, sku_id, quantity_ordered) VALUES (?, ?, ?, ?)`)
        .bind(newId(), orderId, sku.id, item.quantity)
        .run();
    }

    const batch = await autoBatchNewOrders(db, body.warehouseId);

    await logAudit(db, { userId: user.id, action: 'order.manual_create', entityType: 'order', entityId: orderId });
    return new Response(JSON.stringify({ orderId, unmatchedSkus, batch }), { status: 201, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};

export const GET: APIRoute = async (context) => {
  const db = getDb();
  try {
    await requireUser(context, db, ['admin']);
    const warehouseId = new URL(context.request.url).searchParams.get('warehouseId');
    const orders = await db
      .prepare(
        `SELECT o.*,
                (SELECT s.name FROM order_items oi JOIN skus s ON s.id = oi.sku_id WHERE oi.order_id = o.id ORDER BY oi.id LIMIT 1) AS first_item_name,
                (SELECT s.image_url FROM order_items oi JOIN skus s ON s.id = oi.sku_id WHERE oi.order_id = o.id ORDER BY oi.id LIMIT 1) AS first_item_image,
                (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS item_count,
                (SELECT SUM(COALESCE(s.price, 0) * oi.quantity_ordered) FROM order_items oi JOIN skus s ON s.id = oi.sku_id WHERE oi.order_id = o.id) AS order_value
         FROM orders o
         WHERE o.warehouse_id = ?
         ORDER BY o.created_at DESC LIMIT 100`
      )
      .bind(warehouseId)
      .all();
    return new Response(JSON.stringify(orders.results), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};
