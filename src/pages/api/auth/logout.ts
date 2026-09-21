import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/db';
import { clearSession, getCurrentUser } from '../../../lib/auth';
import { recordAttendanceEvent } from '../../../lib/attendance';

export const POST: APIRoute = async (context) => {
  const db = getDb();
  const user = await getCurrentUser(context, db);
  clearSession(context);
  if (user?.warehouse_id) await recordAttendanceEvent(db, user.id, user.warehouse_id, 'logout');
  return new Response(null, { status: 204 });
};
