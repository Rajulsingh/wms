import type { APIRoute } from 'astro';
import { getDb, logAudit, newId } from '../../../lib/db';
import { requireUser, requireOwnWarehouse, AuthError } from '../../../lib/auth';
import { resolveSkuIdByCode } from '../../../lib/skus';
import { reserveOrderForPicking } from '../../../lib/orders';
import { getAdminOrders, type AdminOrderTab, type SentFilter, type SearchField, type SortOption } from '../../../lib/admin-orders';
import { getOrganizationIdForWarehouse } from '../../../lib/org-accounts';

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
    requireOwnWarehouse(user, body.warehouseId);

    const orderId = newId();
    await db
      .prepare(
        `INSERT INTO orders (id, warehouse_id, external_order_id, source, status, priority, customer_name, shipping_address)
         VALUES (?, ?, ?, 'manual', 'pending', ?, ?, ?)`
      )
      .bind(orderId, body.warehouseId, body.externalOrderId, body.priority ?? 0, body.customerName ?? null, body.shippingAddress ?? null)
      .run();

    const organizationId = await getOrganizationIdForWarehouse(db, body.warehouseId);
    const unmatchedSkus: string[] = [];
    for (const item of body.items) {
      const skuId = await resolveSkuIdByCode(db, organizationId, item.skuCode);
      if (!skuId) {
        unmatchedSkus.push(item.skuCode);
        continue;
      }
      await db
        .prepare(`INSERT INTO order_items (id, order_id, sku_id, quantity_ordered) VALUES (?, ?, ?, ?)`)
        .bind(newId(), orderId, skuId, item.quantity)
        .run();
    }

    // Reserves immediately, same as an Amazon-imported order — see
    // reserveOrderForPicking in lib/orders.ts.
    const reserved = await reserveOrderForPicking(db, body.warehouseId, orderId);

    await logAudit(db, { userId: user.id, action: 'order.manual_create', entityType: 'order', entityId: orderId });
    return new Response(
      JSON.stringify({ orderId, unmatchedSkus, blocked: reserved.reserved ? null : reserved.reason }),
      { status: 201, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};

// Amazon-Seller-Central-style browsing: tab (Pending/Unshipped/Sent/
// Cancelled), Sent's own waiting-for-pickup/shipped split, search, sort, and
// real pagination — see getAdminOrders in lib/admin-orders.ts for why the
// tabs are derived from Amazon's own status fields rather than this app's
// internal pick/pack status. Query params all have sane defaults so the
// plain `?warehouseId=` call this endpoint used to only support still works
// (defaults to the 'all' tab, newest first, page 1 of 50).
export const GET: APIRoute = async (context) => {
  const db = getDb();
  try {
    const user = await requireUser(context, db, ['admin']);
    const params = new URL(context.request.url).searchParams;
    const warehouseId = params.get('warehouseId');
    requireOwnWarehouse(user, warehouseId);

    const result = await getAdminOrders(db, warehouseId!, {
      tab: (params.get('tab') as AdminOrderTab) ?? 'all',
      sentFilter: (params.get('sentFilter') as SentFilter) ?? undefined,
      searchField: (params.get('searchField') as SearchField) ?? undefined,
      searchQuery: params.get('searchQuery') ?? undefined,
      sort: (params.get('sort') as SortOption) ?? undefined,
      page: Number(params.get('page') ?? '1') || 1,
      pageSize: Number(params.get('pageSize') ?? '50') || 50
    });
    return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};

/** Sets/clears an order's free-text note (e.g. "free gift included", "multi-qty, double-check count") — surfaced to floor workers on /picker and /packer. */
export const PATCH: APIRoute = async (context) => {
  const db = getDb();
  try {
    const user = await requireUser(context, db, ['admin']);
    const body = await context.request.json<{ orderId: string; notes: string | null }>();

    // orderId alone isn't enough — verify it belongs to this admin's own
    // warehouse before mutating it (same class of bug as the warehouseId
    // checks elsewhere: a bare id from the client is never trusted alone).
    const order = await db.prepare(`SELECT warehouse_id FROM orders WHERE id = ?`).bind(body.orderId).first<{ warehouse_id: string }>();
    if (!order) return new Response(JSON.stringify({ error: 'Order not found' }), { status: 404 });
    requireOwnWarehouse(user, order.warehouse_id);

    const notes = body.notes?.trim() || null;
    await db.prepare(`UPDATE orders SET notes = ? WHERE id = ?`).bind(notes, body.orderId).run();
    await logAudit(db, { userId: user.id, action: 'order.notes_update', entityType: 'order', entityId: body.orderId, metadata: { notes } });
    return new Response(JSON.stringify({ ok: true, notes }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};
