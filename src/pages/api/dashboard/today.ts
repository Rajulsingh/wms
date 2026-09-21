import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/db';
import { requireUser, requireOwnWarehouse, AuthError } from '../../../lib/auth';
import { getTodaySummary } from '../../../lib/dashboard';

// No role restriction — deliberately every logged-in user (packer or admin)
// can see the same warehouse-wide picture, not just admins. See dashboard.ts.
export const GET: APIRoute = async (context) => {
  const db = getDb();
  try {
    const user = await requireUser(context, db);
    const warehouseId = new URL(context.request.url).searchParams.get('warehouseId');
    requireOwnWarehouse(user, warehouseId);

    const summary = await getTodaySummary(db, warehouseId);
    return new Response(JSON.stringify(summary), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};
