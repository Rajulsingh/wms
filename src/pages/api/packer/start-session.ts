import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/db';
import { requireUser, AuthError } from '../../../lib/auth';
import { getMyPackBatches, PackerFlowError } from '../../../lib/packer';

// Also used for polling once a station is active, not just the initial tap-in
// — returns every batch this packer currently has open there, auto-claiming
// a new one only when they have none. See getMyPackBatches in lib/packer.ts.
export const POST: APIRoute = async (context) => {
  const db = getDb();
  try {
    const user = await requireUser(context, db, ['packer']);
    const body = await context.request.json<{ warehouseId: string; stationQrToken: string }>();

    const state = await getMyPackBatches(db, user.id, body.stationQrToken, body.warehouseId);
    return new Response(JSON.stringify(state), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    if (err instanceof PackerFlowError) return new Response(JSON.stringify({ error: err.message, code: err.code }), { status: 409 });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};
