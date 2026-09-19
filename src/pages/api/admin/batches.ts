import type { APIRoute } from 'astro';
import { getDb, logAudit } from '../../../lib/db';
import { requireUser, AuthError } from '../../../lib/auth';
import { createPickBatch } from '../../../lib/orders';

export const POST: APIRoute = async (context) => {
  const db = getDb();
  try {
    const user = await requireUser(context, db, ['admin']);
    const body = await context.request.json<{ warehouseId: string; cartId: string; maxOrders?: number }>();

    const result = await createPickBatch(db, body.warehouseId, {
      cartId: body.cartId,
      maxOrders: body.maxOrders ?? 8
    });

    await logAudit(db, { userId: user.id, action: 'batch.create', entityType: 'pick_batch', entityId: result.batchId, metadata: result });
    return new Response(JSON.stringify(result), { status: 201, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};

export const GET: APIRoute = async (context) => {
  const db = getDb();
  try {
    await requireUser(context, db, ['admin']);
    const warehouseId = new URL(context.request.url).searchParams.get('warehouseId');
    const batches = await db
      .prepare(`SELECT * FROM pick_batches WHERE warehouse_id = ? ORDER BY created_at DESC LIMIT 50`)
      .bind(warehouseId)
      .all();
    return new Response(JSON.stringify(batches.results), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};
