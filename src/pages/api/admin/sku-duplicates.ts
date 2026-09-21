import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/db';
import { requireUser, AuthError } from '../../../lib/auth';
import { findDuplicateSkus } from '../../../lib/skus';
import { getOrganizationIdForWarehouse } from '../../../lib/org-accounts';

export const GET: APIRoute = async (context) => {
  const db = getDb();
  try {
    await requireUser(context, db, ['admin']);
    const warehouseId = new URL(context.request.url).searchParams.get('warehouseId');
    if (!warehouseId) return new Response(JSON.stringify({ error: 'warehouseId is required' }), { status: 400 });
    const organizationId = await getOrganizationIdForWarehouse(db, warehouseId);

    const groups = await findDuplicateSkus(db, organizationId);
    return new Response(JSON.stringify(groups), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};
