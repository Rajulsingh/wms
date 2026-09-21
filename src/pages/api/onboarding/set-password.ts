import type { APIRoute } from 'astro';
import { getDb, logAudit } from '../../../lib/db';
import { createSession } from '../../../lib/auth';
import { setPasswordFromSetupToken, SetupTokenError } from '../../../lib/org-accounts';

export const POST: APIRoute = async (context) => {
  const db = getDb();
  try {
    const body = await context.request.json<{ token: string; password: string }>();
    const token = body.token?.trim();
    const password = body.password ?? '';
    if (!token) return new Response(JSON.stringify({ error: 'Missing setup token' }), { status: 400 });
    if (password.length < 8) return new Response(JSON.stringify({ error: 'Password must be at least 8 characters' }), { status: 400 });

    const adminUserId = await setPasswordFromSetupToken(db, token, password);
    await logAudit(db, { userId: adminUserId, action: 'organization.password_set' });
    await createSession(context, adminUserId);

    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof SetupTokenError) return new Response(JSON.stringify({ error: err.message }), { status: 400 });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};
