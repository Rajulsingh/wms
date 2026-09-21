import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/db';
import { requireUser, requireOwnWarehouse, AuthError } from '../../../lib/auth';
import { activateBatches } from '../../../lib/picker';

// The server-side half of the picker's "Activate pick list" tap (see
// picker/index.astro) — persists it to pick_batches.status so a reload
// doesn't lose it. See activateBatches in lib/picker.ts for the full story.
export const POST: APIRoute = async (context) => {
  const db = getDb();
  try {
    const user = await requireUser(context, db, ['packer']);
    const body = await context.request.json<{ warehouseId: string; shipByDate: string }>();
    requireOwnWarehouse(user, body.warehouseId);
    if (!body.shipByDate) return new Response(JSON.stringify({ error: 'shipByDate is required' }), { status: 400 });
    await activateBatches(db, body.warehouseId, user.id, body.shipByDate);
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};
