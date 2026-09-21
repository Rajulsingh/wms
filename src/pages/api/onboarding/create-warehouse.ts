import type { APIRoute } from 'astro';
import { getDb, logAudit } from '../../../lib/db';
import { getCurrentUser, AuthError } from '../../../lib/auth';
import { createOrganizationWarehouse, getOrganizationForUser } from '../../../lib/org-accounts';

export const POST: APIRoute = async (context) => {
  const db = getDb();
  const user = await getCurrentUser(context, db);
  if (!user || user.role !== 'admin') return new Response(JSON.stringify({ error: 'Not logged in' }), { status: 401 });
  if (user.warehouse_id) return new Response(JSON.stringify({ error: 'This account already has a warehouse' }), { status: 409 });

  const organization = await getOrganizationForUser(db, user.id);
  if (!organization) return new Response(JSON.stringify({ error: 'No organization found for this account' }), { status: 404 });

  try {
    const body = await context.request.json<{ name: string; code: string }>();
    const name = body.name?.trim();
    const code = body.code?.trim().toUpperCase();
    if (!name || !code) return new Response(JSON.stringify({ error: 'Warehouse name and code are required' }), { status: 400 });

    const warehouseId = await createOrganizationWarehouse(db, organization.id, user.id, { name, code });
    await logAudit(db, { userId: user.id, action: 'organization.warehouse_created', entityType: 'warehouse', entityId: warehouseId });

    return new Response(JSON.stringify({ warehouseId }), { status: 201, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    const message = (err as Error).message.includes('UNIQUE') ? 'That warehouse code is already in use' : (err as Error).message;
    return new Response(JSON.stringify({ error: message }), { status: 500 });
  }
};
