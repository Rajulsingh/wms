import type { APIRoute } from 'astro';
import { getDb, logAudit } from '../../../lib/db';
import { requireUser, AuthError } from '../../../lib/auth';
import { syncAmazonCatalog } from '../../../lib/catalog-sync';

export const POST: APIRoute = async (context) => {
  const db = getDb();
  try {
    const user = await requireUser(context, db, ['admin']);
    const result = await syncAmazonCatalog(db);
    await logAudit(db, { userId: user.id, action: 'catalog.sync', metadata: result });
    return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};
