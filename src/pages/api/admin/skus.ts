import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/db';
import { requireUser, requireOwnWarehouse, AuthError } from '../../../lib/auth';
import { getOrganizationIdForWarehouse } from '../../../lib/org-accounts';

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
    const user = await requireUser(context, db, ['admin']);
    const warehouseId = new URL(context.request.url).searchParams.get('warehouseId');
    requireOwnWarehouse(user, warehouseId);
    const organizationId = await getOrganizationIdForWarehouse(db, warehouseId);

    const rows = await db
      .prepare(`SELECT id, sku_code, name, price, image_url, asin, is_parent_asin FROM skus WHERE organization_id = ? AND merged_into_id IS NULL ORDER BY is_parent_asin, sku_code`)
      .bind(organizationId)
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
    const user = await requireUser(context, db, ['admin']);
    const body = await context.request.json<{ skuId: string; warehouseId: string; price?: number | null; reorderPoint?: number | null }>();
    requireOwnWarehouse(user, body.warehouseId);
    const organizationId = await getOrganizationIdForWarehouse(db, body.warehouseId);

    if (body.price !== undefined) {
      if (body.price !== null && (!Number.isFinite(body.price) || body.price < 0)) {
        return new Response(JSON.stringify({ error: 'Price must be a non-negative number' }), { status: 400 });
      }
      // organization_id in the WHERE prevents one org from updating another's SKU by guessing its id (IDOR).
      await db.prepare(`UPDATE skus SET price = ? WHERE id = ? AND organization_id = ?`).bind(body.price, body.skuId, organizationId).run();
    }
    if (body.reorderPoint !== undefined) {
      if (body.reorderPoint !== null && (!Number.isFinite(body.reorderPoint) || body.reorderPoint < 0)) {
        return new Response(JSON.stringify({ error: 'Reorder point must be a non-negative number' }), { status: 400 });
      }
      await db.prepare(`UPDATE skus SET reorder_point = ? WHERE id = ? AND organization_id = ?`).bind(body.reorderPoint, body.skuId, organizationId).run();
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};
