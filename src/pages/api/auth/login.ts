import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/db';
import { assertLoginNotRateLimited, createSession, getClientIp, recordFailedLogin, verifyPin, AuthError } from '../../../lib/auth';
import type { User } from '../../../lib/types';

export const POST: APIRoute = async (context) => {
  const db = getDb();
  const body = await context.request.json<{ name: string; pin: string }>();
  const ip = getClientIp(context);
  const identifier = `pin:${body.name?.trim().toLowerCase() ?? ''}`;

  try {
    await assertLoginNotRateLimited(db, identifier, ip);
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    throw err;
  }

  const user = await db
    .prepare(`SELECT * FROM users WHERE name = ? AND active = 1`)
    .bind(body.name)
    .first<User>();

  if (!user || !(await verifyPin(body.pin, user.pin_hash))) {
    await recordFailedLogin(db, identifier, ip);
    return new Response(JSON.stringify({ error: 'Invalid name or PIN' }), { status: 401 });
  }

  await createSession(context, user.id);
  return new Response(JSON.stringify({ id: user.id, name: user.name, role: user.role, warehouseId: user.warehouse_id }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
};
