import type { APIRoute } from 'astro';
import { getDb, logAudit } from '../../../lib/db';
import { requireUser, AuthError } from '../../../lib/auth';
import { createPickBatch } from '../../../lib/orders';
import { assignBatchToPacker, PickerFlowError } from '../../../lib/picker';

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
      .prepare(
        `SELECT pb.*, u.name AS assigned_picker_name
         FROM pick_batches pb LEFT JOIN users u ON u.id = pb.assigned_picker_id
         WHERE pb.warehouse_id = ? ORDER BY pb.created_at DESC LIMIT 50`
      )
      .bind(warehouseId)
      .all();
    return new Response(JSON.stringify(batches.results), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};

/** Admin hand-assigns a pick batch to a specific packer — see assignBatchToPacker in lib/picker.ts. */
export const PATCH: APIRoute = async (context) => {
  const db = getDb();
  try {
    const admin = await requireUser(context, db, ['admin']);
    const body = await context.request.json<{ warehouseId: string; batchId: string; packerId: string | null }>();

    await assignBatchToPacker(db, body.warehouseId, body.batchId, body.packerId);
    await logAudit(db, {
      userId: admin.id,
      action: body.packerId ? 'batch.assign' : 'batch.unassign',
      entityType: 'pick_batch',
      entityId: body.batchId,
      metadata: { packerId: body.packerId }
    });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    if (err instanceof PickerFlowError) return new Response(JSON.stringify({ error: err.message, code: err.code }), { status: 409 });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};
