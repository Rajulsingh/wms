import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/db';
import { requireUser, AuthError } from '../../../lib/auth';
import { claimNextBatch, getPickListView } from '../../../lib/picker';

export const POST: APIRoute = async (context) => {
  const db = getDb();
  try {
    const user = await requireUser(context, db, ['packer']);
    const body = await context.request.json<{ warehouseId: string }>();

    const batchId = await claimNextBatch(db, body.warehouseId, user.id);
    if (!batchId) {
      return new Response(JSON.stringify({ batchId: null, rows: [], message: 'No batches available right now' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    const rows = await getPickListView(db, batchId);
    return new Response(JSON.stringify({ batchId, rows }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};
