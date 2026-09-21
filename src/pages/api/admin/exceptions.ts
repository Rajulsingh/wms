import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/db';
import { requireUser, requireOwnWarehouse, AuthError } from '../../../lib/auth';

/**
 * Every short pick, damage report, wrong-location/SKU scan, duplicate AWB,
 * etc. has been logged to exception_events (see logException, lib/db.ts)
 * since the very first pass — but nothing ever read them back. A picker/
 * packer choosing "Low stock" or "Damaged" and typing a note had no
 * admin-visible trail at all until this endpoint. Resolves the order a
 * given exception belongs to via whichever of its three optional FKs
 * (order_id directly, or pick_task_id/pack_session_id indirectly) is
 * populated — reset.ts nulls all three on a reset rather than deleting the
 * row, so a historical exception can outlive the order it was about.
 */
export const GET: APIRoute = async (context) => {
  const db = getDb();
  try {
    const user = await requireUser(context, db, ['admin']);
    const url = new URL(context.request.url);
    const warehouseId = url.searchParams.get('warehouseId');
    requireOwnWarehouse(user, warehouseId);
    const includeResolved = url.searchParams.get('includeResolved') === 'true';

    // The order-less fallback (an exception with none of order_id/
    // pick_task_id/pack_session_id set) used to match for *any* warehouse —
    // scoped instead via the logging user's own warehouse_id, since that's
    // the only warehouse signal an order-less exception carries.
    const rows = await db
      .prepare(
        `SELECT ee.id, ee.type, ee.notes, ee.resolved, ee.created_at, u.name AS user_name,
                COALESCE(o1.id, o2.id, o3.id) AS order_id,
                COALESCE(o1.external_order_id, o2.external_order_id, o3.external_order_id) AS external_order_id,
                sk.sku_code, sk.name AS sku_name
         FROM exception_events ee
         LEFT JOIN users u ON u.id = ee.user_id
         LEFT JOIN orders o1 ON o1.id = ee.order_id
         LEFT JOIN pick_tasks pt ON pt.id = ee.pick_task_id
         LEFT JOIN order_items oi ON oi.id = pt.order_item_id
         LEFT JOIN orders o2 ON o2.id = oi.order_id
         LEFT JOIN pack_sessions ps ON ps.id = ee.pack_session_id
         LEFT JOIN orders o3 ON o3.id = ps.order_id
         LEFT JOIN skus sk ON sk.id = pt.sku_id
         WHERE (COALESCE(o1.warehouse_id, o2.warehouse_id, o3.warehouse_id) = ?
                OR (o1.id IS NULL AND o2.id IS NULL AND o3.id IS NULL AND u.warehouse_id = ?))
           AND (? = 1 OR ee.resolved = 0)
         ORDER BY ee.resolved ASC, ee.created_at DESC
         LIMIT 300`
      )
      .bind(warehouseId, warehouseId, includeResolved ? 1 : 0)
      .all();

    return new Response(JSON.stringify(rows.results), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};

/** Marks one exception resolved/unresolved — a record of "someone looked at this and dealt with it", not a delete (the row stays for history either way). */
export const PATCH: APIRoute = async (context) => {
  const db = getDb();
  try {
    const user = await requireUser(context, db, ['admin']);
    const body = await context.request.json<{ id: string; resolved: boolean }>();

    // Resolve the exception's warehouse the same way GET does — via
    // whichever of order_id/pick_task_id/pack_session_id is populated, or
    // the logging user's own warehouse for an order-less exception.
    const owner = await db
      .prepare(
        `SELECT COALESCE(o1.warehouse_id, o2.warehouse_id, o3.warehouse_id, u.warehouse_id) AS warehouse_id
         FROM exception_events ee
         LEFT JOIN users u ON u.id = ee.user_id
         LEFT JOIN orders o1 ON o1.id = ee.order_id
         LEFT JOIN pick_tasks pt ON pt.id = ee.pick_task_id
         LEFT JOIN order_items oi ON oi.id = pt.order_item_id
         LEFT JOIN orders o2 ON o2.id = oi.order_id
         LEFT JOIN pack_sessions ps ON ps.id = ee.pack_session_id
         LEFT JOIN orders o3 ON o3.id = ps.order_id
         WHERE ee.id = ?`
      )
      .bind(body.id)
      .first<{ warehouse_id: string | null }>();
    if (!owner) return new Response(JSON.stringify({ error: 'Exception not found' }), { status: 404 });
    requireOwnWarehouse(user, owner.warehouse_id);

    await db.prepare(`UPDATE exception_events SET resolved = ? WHERE id = ?`).bind(body.resolved ? 1 : 0, body.id).run();
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};
