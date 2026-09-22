import type { APIRoute } from 'astro';
import { getDb } from '../../../../lib/db';
import { requireUser, requireOwnWarehouse, AuthError } from '../../../../lib/auth';
import { getTodayOtp, setTodayOtp } from '../../../../lib/returns';

export const GET: APIRoute = async (context) => {
  const db = getDb();
  try {
    const user = await requireUser(context, db, ['admin']);
    const warehouseId = new URL(context.request.url).searchParams.get('warehouseId');
    requireOwnWarehouse(user, warehouseId);

    const otp = await getTodayOtp(db, warehouseId);
    return new Response(JSON.stringify({ otp }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};

/** Today's return OTP, read off Seller Central by hand each morning — see lib/returns.ts, there is no API field for it. */
export const POST: APIRoute = async (context) => {
  const db = getDb();
  try {
    const user = await requireUser(context, db, ['admin']);
    const body = await context.request.json<{ warehouseId: string; otp: string; validForCount?: number | string | null }>();
    requireOwnWarehouse(user, body.warehouseId);

    const validForCount =
      body.validForCount === '' || body.validForCount === null || body.validForCount === undefined ? null : Number(body.validForCount);
    await setTodayOtp(db, body.warehouseId, user.id, body.otp, validForCount);
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 400 });
  }
};
