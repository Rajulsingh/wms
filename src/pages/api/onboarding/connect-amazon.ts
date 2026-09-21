import type { APIRoute } from 'astro';
import { getDb, logAudit } from '../../../lib/db';
import { getCurrentUser } from '../../../lib/auth';
import { getOrganizationForUser, saveAmazonCredentials } from '../../../lib/org-accounts';

export const POST: APIRoute = async (context) => {
  const db = getDb();
  const user = await getCurrentUser(context, db);
  if (!user || user.role !== 'admin') return new Response(JSON.stringify({ error: 'Not logged in' }), { status: 401 });

  const organization = await getOrganizationForUser(db, user.id);
  if (!organization) return new Response(JSON.stringify({ error: 'No organization found for this account' }), { status: 404 });

  try {
    const body = await context.request.json<{
      clientId: string;
      clientSecret: string;
      refreshToken: string;
      marketplaceId: string;
      merchantId?: string;
      sandbox?: boolean;
    }>();
    const clientId = body.clientId?.trim();
    const clientSecret = body.clientSecret?.trim();
    const refreshToken = body.refreshToken?.trim();
    const marketplaceId = body.marketplaceId?.trim();
    if (!clientId || !clientSecret || !refreshToken || !marketplaceId) {
      return new Response(JSON.stringify({ error: 'Client ID, client secret, refresh token, and marketplace ID are all required' }), { status: 400 });
    }

    await saveAmazonCredentials(db, organization.id, {
      clientId,
      clientSecret,
      refreshToken,
      marketplaceId,
      merchantId: body.merchantId?.trim() || undefined,
      sandbox: body.sandbox
    });
    await logAudit(db, { userId: user.id, action: 'organization.amazon_connected', entityType: 'organization', entityId: organization.id });

    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};
