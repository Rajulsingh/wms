import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/db';
import { requireUser, AuthError } from '../../../lib/auth';
import { getBatchState, PickerFlowError } from '../../../lib/picker';

export const GET: APIRoute = async (context) => {
  const db = getDb();
  try {
    await requireUser(context, db, ['packer']);
    const batchId = new URL(context.request.url).searchParams.get('batchId');
    if (!batchId) return new Response(JSON.stringify({ error: 'batchId required' }), { status: 400 });

    const state = await getBatchState(db, batchId);
    return new Response(JSON.stringify(state), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    if (err instanceof PickerFlowError) return new Response(JSON.stringify({ error: err.message, code: err.code }), { status: 404 });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};
