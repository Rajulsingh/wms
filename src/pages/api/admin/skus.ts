import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/db';
import { requireUser, AuthError } from '../../../lib/auth';

// Every non-merged SKU, active and inactive alike — the full catalog view on
// Receiving (inbound.astro) so an admin can see everything Amazon knows
// about, not just what's currently sellable. `is_parent_asin` is exposed
// as-is rather than pre-filtered here: unlike the receiving product search
// (see inbound.ts, which excludes it because it must never be a stock-receipt
// target) or duplicate-scan (skus.ts, which excludes it because it can never
// be a fresh duplicate candidate), this listing's whole point is to show
// both states side by side.
export const GET: APIRoute = async (context) => {
  const db = getDb();
  try {
    await requireUser(context, db, ['admin']);
    const rows = await db
      .prepare(`SELECT id, sku_code, name, price, image_url, asin, is_parent_asin FROM skus WHERE merged_into_id IS NULL ORDER BY is_parent_asin, sku_code`)
      .all();
    return new Response(JSON.stringify(rows.results), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};

export const PATCH: APIRoute = async (context) => {
  const db = getDb();
  try {
    await requireUser(context, db, ['admin']);
    const body = await context.request.json<{ skuId: string; price?: number | null; reorderPoint?: number | null }>();

    if (body.price !== undefined) {
      if (body.price !== null && (!Number.isFinite(body.price) || body.price < 0)) {
        return new Response(JSON.stringify({ error: 'Price must be a non-negative number' }), { status: 400 });
      }
      await db.prepare(`UPDATE skus SET price = ? WHERE id = ?`).bind(body.price, body.skuId).run();
    }
    if (body.reorderPoint !== undefined) {
      if (body.reorderPoint !== null && (!Number.isFinite(body.reorderPoint) || body.reorderPoint < 0)) {
        return new Response(JSON.stringify({ error: 'Reorder point must be a non-negative number' }), { status: 400 });
      }
      await db.prepare(`UPDATE skus SET reorder_point = ? WHERE id = ?`).bind(body.reorderPoint, body.skuId).run();
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};
