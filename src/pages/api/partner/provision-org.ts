import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getDb, logAudit } from '../../../lib/db';
import { createOrganizationSignup, SignupError } from '../../../lib/org-accounts';
import { timingSafeEqual } from '../../../lib/crypto';

/**
 * The "one command" integration seam for ecomglider.com (or any future
 * partner surface): given a seller's name/email, provisions an organization
 * and returns a setup link — no password is collected here since there's no
 * human at this WMS's own UI to type one (see org-accounts.ts's setup-token
 * path, same one used by /onboarding/set-password). ecomglider's own backend
 * calls this after a successful purchase; nothing on ecomglider itself needs
 * to change today for this endpoint to exist and be ready.
 *
 * Auth is a single shared bearer secret (PARTNER_API_KEY, set via `wrangler
 * secret put`) — sufficient for a single trusted server-to-server caller.
 * Move to per-partner keys if a second caller is ever added.
 */
export const POST: APIRoute = async (context) => {
  const db = getDb();

  const configuredKey = env.PARTNER_API_KEY;
  if (!configuredKey) {
    return new Response(JSON.stringify({ error: 'PARTNER_API_KEY not configured on this deploy' }), { status: 503 });
  }
  const authHeader = context.request.headers.get('Authorization') ?? '';
  const providedKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!providedKey || !timingSafeEqual(providedKey, configuredKey)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  }

  try {
    const body = await context.request.json<{ orgName: string; ownerName: string; email: string }>();
    const orgName = body.orgName?.trim();
    const ownerName = body.ownerName?.trim();
    const email = body.email?.trim();
    if (!orgName || !ownerName || !email) {
      return new Response(JSON.stringify({ error: 'orgName, ownerName, and email are required' }), { status: 400 });
    }

    const { organization, setupToken } = await createOrganizationSignup(db, { orgName, ownerName, email });
    await logAudit(db, { userId: null, action: 'organization.partner_provisioned', entityType: 'organization', entityId: organization.id, metadata: { email, orgName } });

    const setupUrl = new URL('/onboarding/set-password', context.request.url);
    setupUrl.searchParams.set('token', setupToken!);

    return new Response(
      JSON.stringify({ organizationId: organization.id, setupUrl: setupUrl.toString() }),
      { status: 201, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    if (err instanceof SignupError) return new Response(JSON.stringify({ error: err.message }), { status: 409 });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};
