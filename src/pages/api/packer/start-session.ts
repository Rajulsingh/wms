import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/db';
import { requireUser, requireOwnWarehouse, AuthError } from '../../../lib/auth';
import { getMyPackBatches, PackerFlowError } from '../../../lib/packer';

// Also used for polling once packing has started, not just the initial
// load — returns every batch this packer currently has open, plus a sweep
// for anything freshly ready, on every call. Station comes from the
// packer's own account (users.station_id), not a per-call token — see
// getMyPackBatches in lib/packer.ts.
export const POST: APIRoute = async (context) => {
  const db = getDb();
  try {
    const user = await requireUser(context, db, ['packer']);
    if (!user.station_id) {
      throw new PackerFlowError('no_station', 'No packing station is assigned to your account yet — ask an admin to assign one in Users.');
    }
    const body = await context.request.json<{ warehouseId: string }>();
    requireOwnWarehouse(user, body.warehouseId);

    const state = await getMyPackBatches(db, user.id, user.station_id, body.warehouseId);
    return new Response(JSON.stringify(state), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    if (err instanceof PackerFlowError) return new Response(JSON.stringify({ error: err.message, code: err.code }), { status: 409 });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};
