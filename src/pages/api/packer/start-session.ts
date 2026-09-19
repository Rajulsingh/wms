import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/db';
import { requireUser, AuthError } from '../../../lib/auth';
import { getMyPackBatches, getPendingLabelQueue, PackerFlowError } from '../../../lib/packer';

// Also used for polling once a station is active, not just the initial tap-in
// — returns every batch this packer currently has open there, plus a sweep
// for anything freshly ready, on every call. See getMyPackBatches in lib/packer.ts.
// `pendingLabels` is included on every call too (tap-in and poll alike) so a
// packer who navigated away mid-labeling always gets the outstanding AWB
// queue back the moment they return — see getPendingLabelQueue.
export const POST: APIRoute = async (context) => {
  const db = getDb();
  try {
    const user = await requireUser(context, db, ['packer']);
    const body = await context.request.json<{ warehouseId: string; stationQrToken: string }>();

    const state = await getMyPackBatches(db, user.id, body.stationQrToken, body.warehouseId);
    const pendingLabels = await getPendingLabelQueue(db, user.id);
    return new Response(JSON.stringify({ ...state, pendingLabels }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    if (err instanceof PackerFlowError) return new Response(JSON.stringify({ error: err.message, code: err.code }), { status: 409 });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};
