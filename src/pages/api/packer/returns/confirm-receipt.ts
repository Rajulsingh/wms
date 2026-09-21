import type { APIRoute } from 'astro';
import { getDb } from '../../../../lib/db';
import { requireUser, requireOwnWarehouse, AuthError } from '../../../../lib/auth';
import { confirmTodayReceipt } from '../../../../lib/returns';

export const POST: APIRoute = async (context) => {
  const db = getDb();
  try {
    const user = await requireUser(context, db, ['packer']);
    requireOwnWarehouse(user, user.warehouse_id);
    const body = await context.request.json<{ receivedCount: number }>();

    const receipt = await confirmTodayReceipt(db, user.warehouse_id, user.id, body.receivedCount);
    return new Response(JSON.stringify({ receipt }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 400 });
  }
};
