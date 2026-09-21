import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/db';
import { createSession } from '../../../lib/auth';
import { verifyOrgLogin } from '../../../lib/org-accounts';

/** Email+password login for org owners — separate mechanism from the floor PIN login (api/auth/login.ts), same session cookie underneath. See migrations/0025_organizations.sql. */
export const POST: APIRoute = async (context) => {
  const db = getDb();
  const body = await context.request.json<{ email: string; password: string }>();
  const email = body.email?.trim();
  const password = body.password ?? '';
  if (!email || !password) {
    return new Response(JSON.stringify({ error: 'Email and password are required' }), { status: 400 });
  }

  const userId = await verifyOrgLogin(db, email, password);
  if (!userId) {
    return new Response(JSON.stringify({ error: 'Incorrect email or password' }), { status: 401 });
  }

  await createSession(context, userId);
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
