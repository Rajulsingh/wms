import type { APIRoute } from 'astro';
import { getDb, logAudit } from '../../../lib/db';
import { requireUser, AuthError } from '../../../lib/auth';
import { retryBlockedOrders } from '../../../lib/orders';
import { assignBatchToPacker, PickerFlowError } from '../../../lib/picker';

// "Assign orders to pick list" on /admin — reservation already happens
// automatically at import/creation time (see reserveOrderForPicking in
// lib/orders.ts), so this is the manual nudge for whatever's still blocked
// (almost always insufficient stock), for an admin to trigger right after
// fixing it rather than waiting on the automatic retry in receiveStock or a
// picker's next poll. See HANDOFF.md.
export const POST: APIRoute = async (context) => {
  const db = getDb();
  try {
    const user = await requireUser(context, db, ['admin']);
    const body = await context.request.json<{ warehouseId: string }>();

    const result = await retryBlockedOrders(db, body.warehouseId);

    await logAudit(db, { userId: user.id, action: 'orders.retry_blocked', entityType: 'warehouse', entityId: body.warehouseId, metadata: result });
    return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
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
