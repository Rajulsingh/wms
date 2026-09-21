import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/db';
import { requireUser, requireOwnWarehouse, AuthError } from '../../../lib/auth';
import { listReturnsForAdmin, markClaimFiled, getReturnById } from '../../../lib/returns';

export const GET: APIRoute = async (context) => {
  const db = getDb();
  try {
    const user = await requireUser(context, db, ['admin']);
    const url = new URL(context.request.url);
    const warehouseId = url.searchParams.get('warehouseId');
    requireOwnWarehouse(user, warehouseId);
    const status = url.searchParams.get('status') || undefined;

    const returns = await listReturnsForAdmin(db, warehouseId, status);
    return new Response(JSON.stringify({ returns }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};

/** Marks a "safe to claim" return as claim_filed once the admin has actually submitted the SAFE-T claim in Seller Central — this is just our own tracking, it never files anything on Amazon's side. */
export const PATCH: APIRoute = async (context) => {
  const db = getDb();
  try {
    const user = await requireUser(context, db, ['admin']);
    const body = await context.request.json<{ returnId: string }>();

    const existing = await getReturnById(db, body.returnId);
    if (!existing) return new Response(JSON.stringify({ error: 'Return not found' }), { status: 404 });
    requireOwnWarehouse(user, existing.warehouseId);

    await markClaimFiled(db, body.returnId, user.id);
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 400 });
  }
};
