import type { APIRoute } from 'astro';
import { getDb, logAudit } from '../../../lib/db';
import { requireUser, AuthError } from '../../../lib/auth';
import { fetchUnfulfilledOrders } from '../../../lib/amazon';
import { importAmazonOrders, autoBatchNewOrders } from '../../../lib/orders';

export const POST: APIRoute = async (context) => {
  const db = getDb();
  try {
    const user = await requireUser(context, db, ['admin']);
    const body = await context.request.json<{ warehouseId: string; sinceHours?: number }>();
    const since = new Date(Date.now() - (body.sinceHours ?? 24) * 60 * 60 * 1000);

    const amazonOrders = await fetchUnfulfilledOrders(since);
    const summary = await importAmazonOrders(db, body.warehouseId, amazonOrders);
    const batch = summary.imported > 0 ? await autoBatchNewOrders(db, body.warehouseId) : null;

    await logAudit(db, { userId: user.id, action: 'import.amazon_orders', metadata: summary });
    return new Response(JSON.stringify({ ...summary, batch }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};
