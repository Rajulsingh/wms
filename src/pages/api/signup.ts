import type { APIRoute } from 'astro';
import { getDb, logAudit } from '../../lib/db';
import { createSession } from '../../lib/auth';
import { createOrganizationSignup, SignupError } from '../../lib/org-accounts';

export const POST: APIRoute = async (context) => {
  const db = getDb();
  try {
    const body = await context.request.json<{ orgName: string; ownerName: string; email: string; password: string }>();
    const orgName = body.orgName?.trim();
    const ownerName = body.ownerName?.trim();
    const email = body.email?.trim();
    const password = body.password ?? '';

    if (!orgName || !ownerName || !email) {
      return new Response(JSON.stringify({ error: 'Business name, your name, and email are required' }), { status: 400 });
    }
    if (password.length < 8) {
      return new Response(JSON.stringify({ error: 'Password must be at least 8 characters' }), { status: 400 });
    }

    const { adminUserId } = await createOrganizationSignup(db, { orgName, ownerName, email, password });
    await logAudit(db, { userId: adminUserId, action: 'organization.signup', metadata: { orgName, email } });
    await createSession(context, adminUserId);

    return new Response(JSON.stringify({ ok: true }), { status: 201, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof SignupError) return new Response(JSON.stringify({ error: err.message }), { status: 409 });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};
