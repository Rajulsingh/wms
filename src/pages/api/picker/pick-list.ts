import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/db';
import { requireUser, AuthError } from '../../../lib/auth';
import { getPickListView } from '../../../lib/picker';

export const GET: APIRoute = async (context) => {
  const db = getDb();
  try {
    await requireUser(context, db, ['packer']);
    const batchId = new URL(context.request.url).searchParams.get('batchId');
    if (!batchId) return new Response(JSON.stringify({ error: 'batchId required' }), { status: 400 });

    const rows = await getPickListView(db, batchId);
    return new Response(JSON.stringify(rows), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};
