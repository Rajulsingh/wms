import type { APIRoute } from 'astro';
import { getDb } from '../../../../lib/db';
import { requireUser, requireOwnWarehouse, AuthError } from '../../../../lib/auth';
import { listReturnsForExport } from '../../../../lib/returns';

/** Uncapped, date-ranged returns data for the admin's CSV download — see listReturnsForExport in lib/returns.ts. Returns JSON; the client builds the actual CSV, same pattern as admin/pick-list.astro's own download button. */
export const GET: APIRoute = async (context) => {
  const db = getDb();
  try {
    const user = await requireUser(context, db, ['admin']);
    const url = new URL(context.request.url);
    const warehouseId = url.searchParams.get('warehouseId');
    requireOwnWarehouse(user, warehouseId);
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    if (!from || !to) return new Response(JSON.stringify({ error: 'from and to dates are required' }), { status: 400 });

    const returns = await listReturnsForExport(db, warehouseId, from, to);
    return new Response(JSON.stringify({ returns }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};
