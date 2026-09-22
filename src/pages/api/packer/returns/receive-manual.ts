import type { APIRoute } from 'astro';
import { getDb } from '../../../../lib/db';
import { requireUser, requireOwnWarehouse, AuthError } from '../../../../lib/auth';
import { markReturnReceived } from '../../../../lib/returns';

/** Fallback for a damaged/unreadable label a scanner can't read — the packer picks the specific return directly off the "Awaiting receipt" list instead of a code resolving it, still one deliberate per-return action rather than a blind count. */
export const POST: APIRoute = async (context) => {
  const db = getDb();
  try {
    const user = await requireUser(context, db, ['packer']);
    requireOwnWarehouse(user, user.warehouse_id);
    const body = await context.request.json<{ returnId: string }>();
    if (!body.returnId) return new Response(JSON.stringify({ error: 'returnId is required' }), { status: 400 });

    const received = await markReturnReceived(db, user.warehouse_id, user.id, body.returnId, 'manual');
    return new Response(JSON.stringify(received), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 400 });
  }
};
