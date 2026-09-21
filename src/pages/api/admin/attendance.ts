import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/db';
import { requireUser, requireOwnWarehouse, AuthError } from '../../../lib/auth';
import { getTodayAttendance, getAttendanceHistory } from '../../../lib/attendance';

export const GET: APIRoute = async (context) => {
  const db = getDb();
  try {
    const user = await requireUser(context, db, ['admin']);
    const url = new URL(context.request.url);
    const warehouseId = url.searchParams.get('warehouseId');
    requireOwnWarehouse(user, warehouseId);
    const days = Number(url.searchParams.get('days') ?? '14') || 14;

    const [today, history] = await Promise.all([getTodayAttendance(db, warehouseId), getAttendanceHistory(db, warehouseId, days)]);
    return new Response(JSON.stringify({ today, history }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};
