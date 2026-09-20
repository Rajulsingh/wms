import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/db';
import { getCurrentUser, toClientUser } from '../../../lib/auth';

export const GET: APIRoute = async (context) => {
  const db = getDb();
  const user = await getCurrentUser(context, db);
  if (!user) return new Response(JSON.stringify({ user: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  return new Response(JSON.stringify({ user: toClientUser(user) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
