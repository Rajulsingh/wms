import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/db';
import { createSession, verifyPin } from '../../../lib/auth';
import type { User } from '../../../lib/types';

export const POST: APIRoute = async (context) => {
  const db = getDb();
  const body = await context.request.json<{ name: string; pin: string }>();

  const user = await db
    .prepare(`SELECT * FROM users WHERE name = ? AND active = 1`)
    .bind(body.name)
    .first<User>();

  if (!user || !(await verifyPin(body.pin, user.pin_hash))) {
    return new Response(JSON.stringify({ error: 'Invalid name or PIN' }), { status: 401 });
  }

  await createSession(context, user.id);
  return new Response(JSON.stringify({ id: user.id, name: user.name, role: user.role, warehouseId: user.warehouse_id }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
};
