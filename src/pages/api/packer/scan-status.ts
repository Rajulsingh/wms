import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/db';
import { requireUser, AuthError } from '../../../lib/auth';
import { getPendingLabels, getTodayScans } from '../../../lib/packer';

// Powers the Scan page's initial load and refresh — everything read from
// the database, not held in browser memory, so a reload never loses state.
export const GET: APIRoute = async (context) => {
  const db = getDb();
  try {
    await requireUser(context, db, ['packer']);
    const warehouseId = new URL(context.request.url).searchParams.get('warehouseId');
    if (!warehouseId) return new Response(JSON.stringify({ error: 'warehouseId required' }), { status: 400 });

    const pending = await getPendingLabels(db, warehouseId);
    const todayScans = await getTodayScans(db, warehouseId);
    return new Response(JSON.stringify({ pending, todayScans }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};
