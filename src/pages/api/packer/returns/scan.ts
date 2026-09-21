import type { APIRoute } from 'astro';
import { getDb } from '../../../../lib/db';
import { requireUser, requireOwnWarehouse, AuthError } from '../../../../lib/auth';
import { findReturnByScan } from '../../../../lib/returns';

export const POST: APIRoute = async (context) => {
  const db = getDb();
  try {
    const user = await requireUser(context, db, ['packer']);
    requireOwnWarehouse(user, user.warehouse_id);
    const body = await context.request.json<{ code: string }>();

    const found = await findReturnByScan(db, user.warehouse_id, body.code ?? '');
    if (!found) return new Response(JSON.stringify({ error: 'No expected return matches that code' }), { status: 404 });
    return new Response(JSON.stringify(found), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};
