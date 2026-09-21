import type { APIRoute } from 'astro';
import { getDb, logAudit } from '../../../lib/db';
import { requireUser, requireOwnWarehouse, AuthError } from '../../../lib/auth';
import { assignSkusToPacker, PickerFlowError } from '../../../lib/picker';

export const POST: APIRoute = async (context) => {
  const db = getDb();
  try {
    const admin = await requireUser(context, db, ['admin']);
    const body = await context.request.json<{ warehouseId: string; skuIds: string[]; packerId: string }>();
    requireOwnWarehouse(admin, body.warehouseId);

    if (!body.skuIds?.length) return new Response(JSON.stringify({ error: 'Select at least one SKU' }), { status: 400 });
    if (!body.packerId) return new Response(JSON.stringify({ error: 'Select a packer' }), { status: 400 });

    const result = await assignSkusToPacker(db, body.warehouseId, body.skuIds, body.packerId);
    await logAudit(db, {
      userId: admin.id,
      action: 'pick.assign_by_sku',
      entityType: 'user',
      entityId: body.packerId,
      metadata: { skuIds: body.skuIds, ...result }
    });
    return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    if (err instanceof PickerFlowError) return new Response(JSON.stringify({ error: err.message, code: err.code }), { status: 409 });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};
