import type { APIRoute } from 'astro';
import { getDb, logAudit } from '../../../lib/db';
import { requireUser, AuthError } from '../../../lib/auth';
import { fetchOrderById } from '../../../lib/amazon';
import { importAmazonOrders } from '../../../lib/orders';

/**
 * Backfills one specific Amazon order by id, bypassing the normal sync's
 * `LastUpdatedAfter` window entirely — the escape hatch for an order that's
 * gone quiet on Amazon's side for longer than any sync lookback and is
 * therefore invisible to the regular pull (see HANDOFF.md,
 * `fetchOrderById` in amazon.ts). Reuses the exact same `importAmazonOrders`
 * every regular sync uses, so this can't diverge from normal import
 * behavior (SKU resolution, stock reservation, dedup-by-external-id all
 * apply identically) — the only difference is where the order came from.
 */
export const POST: APIRoute = async (context) => {
  const db = getDb();
  try {
    const user = await requireUser(context, db, ['admin']);
    const body = await context.request.json<{ warehouseId: string; amazonOrderId: string }>();
    const amazonOrderId = body.amazonOrderId?.trim();
    if (!amazonOrderId) return new Response(JSON.stringify({ error: 'amazonOrderId is required' }), { status: 400 });

    const order = await fetchOrderById(amazonOrderId);
    const summary = await importAmazonOrders(db, body.warehouseId, [order]);
    await logAudit(db, { userId: user.id, action: 'order.manual_import_by_id', entityType: 'order', entityId: amazonOrderId, metadata: summary });

    return new Response(JSON.stringify(summary), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};
