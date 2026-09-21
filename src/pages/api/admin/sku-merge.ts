import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/db';
import { requireUser, requireOwnWarehouse, AuthError } from '../../../lib/auth';
import { previewSkuMerge, mergeSku, SkuMergeError } from '../../../lib/skus';
import { getOrganizationIdForWarehouse } from '../../../lib/org-accounts';

/** Read-only preview of what a merge would move — shown before the admin commits to it. */
export const GET: APIRoute = async (context) => {
  const db = getDb();
  try {
    const user = await requireUser(context, db, ['admin']);
    const url = new URL(context.request.url);
    const sourceCode = url.searchParams.get('sourceCode');
    const targetCode = url.searchParams.get('targetCode');
    const warehouseId = url.searchParams.get('warehouseId');
    if (!sourceCode || !targetCode) return new Response(JSON.stringify({ error: 'sourceCode and targetCode are required' }), { status: 400 });
    requireOwnWarehouse(user, warehouseId);
    const organizationId = await getOrganizationIdForWarehouse(db, warehouseId);

    const preview = await previewSkuMerge(db, organizationId, sourceCode, targetCode);
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
    const body = await context.request.json<{ sourceCode: string; targetCode: string; warehouseId: string }>();
    requireOwnWarehouse(user, body.warehouseId);
    const organizationId = await getOrganizationIdForWarehouse(db, body.warehouseId);

    const result = await mergeSku(db, user.id, organizationId, body.sourceCode, body.targetCode);
    return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    if (err instanceof SkuMergeError) return new Response(JSON.stringify({ error: err.message, code: err.code }), { status: 409 });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};
