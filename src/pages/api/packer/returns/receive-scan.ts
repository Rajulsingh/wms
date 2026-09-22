import type { APIRoute } from 'astro';
import { getDb } from '../../../../lib/db';
import { requireUser, requireOwnWarehouse, AuthError } from '../../../../lib/auth';
import { receiveReturnByScan } from '../../../../lib/returns';

/** Scans a physical AWB/order-id code and, if it matches something awaiting receipt, marks that specific return received — see receiveReturnByScan in lib/returns.ts for why this replaced the old headcount-only flow. */
export const POST: APIRoute = async (context) => {
  const db = getDb();
  try {
    const user = await requireUser(context, db, ['packer']);
    requireOwnWarehouse(user, user.warehouse_id);
    const body = await context.request.json<{ code: string }>();

    const received = await receiveReturnByScan(db, user.warehouse_id, user.id, body.code ?? '');
    return new Response(JSON.stringify(received), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 400 });
  }
};
