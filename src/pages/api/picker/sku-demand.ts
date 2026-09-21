import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/db';
import { requireUser, requireOwnWarehouse, AuthError } from '../../../lib/auth';
import { getUnassignedSkuDemand } from '../../../lib/picker';

// No role restriction, deliberately — the packer dashboard's read-only
// "what's waiting" preview and the admin's bulk-assign-by-SKU screen both
// call this exact endpoint so they can never show different numbers for the
// same pile of unclaimed work. See getUnassignedSkuDemand in lib/picker.ts.
export const GET: APIRoute = async (context) => {
  const db = getDb();
  try {
    const user = await requireUser(context, db);
    const warehouseId = new URL(context.request.url).searchParams.get('warehouseId');
    requireOwnWarehouse(user, warehouseId);

    const demand = await getUnassignedSkuDemand(db, warehouseId);
    return new Response(JSON.stringify(demand), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};
