import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/db';
import { requireUser, requireOwnWarehouse, AuthError } from '../../../lib/auth';
import { getExpectedReturns, getTodayOtp, getTodayReceipt } from '../../../lib/returns';

export const GET: APIRoute = async (context) => {
  const db = getDb();
  try {
    const user = await requireUser(context, db, ['packer']);
    requireOwnWarehouse(user, user.warehouse_id);

    const [expected, otp, receipt] = await Promise.all([
      getExpectedReturns(db, user.warehouse_id),
      getTodayOtp(db, user.warehouse_id),
      getTodayReceipt(db, user.warehouse_id)
    ]);
    return new Response(JSON.stringify({ expected, otp, receipt }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};
