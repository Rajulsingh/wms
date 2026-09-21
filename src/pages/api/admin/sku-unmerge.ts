import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/db';
import { requireUser, AuthError } from '../../../lib/auth';
import { previewSkuUnmerge, unmergeSku, SkuMergeError } from '../../../lib/skus';
import { getOrganizationIdForWarehouse } from '../../../lib/org-accounts';

/** Read-only — what a SKU is currently merged into, shown before the admin commits to unmerging it. */
export const GET: APIRoute = async (context) => {
  const db = getDb();
  try {
    await requireUser(context, db, ['admin']);
    const url = new URL(context.request.url);
    const sourceCode = url.searchParams.get('sourceCode');
    const warehouseId = url.searchParams.get('warehouseId');
    if (!sourceCode || !warehouseId) return new Response(JSON.stringify({ error: 'sourceCode and warehouseId are required' }), { status: 400 });
    const organizationId = await getOrganizationIdForWarehouse(db, warehouseId);

    const preview = await previewSkuUnmerge(db, organizationId, sourceCode);
    return new Response(JSON.stringify(preview), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    if (err instanceof SkuMergeError) return new Response(JSON.stringify({ error: err.message, code: err.code }), { status: 409 });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};

export const POST: APIRoute = async (context) => {
  const db = getDb();
  try {
    const user = await requireUser(context, db, ['admin']);
    const body = await context.request.json<{ sourceCode: string; warehouseId: string }>();
    const organizationId = await getOrganizationIdForWarehouse(db, body.warehouseId);

    const result = await unmergeSku(db, user.id, organizationId, body.sourceCode);
    return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    if (err instanceof SkuMergeError) return new Response(JSON.stringify({ error: err.message, code: err.code }), { status: 409 });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};
