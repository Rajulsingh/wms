import type { APIRoute } from 'astro';
import { getDb } from '../../../../lib/db';
import { requireUser, requireOwnWarehouse, AuthError } from '../../../../lib/auth';
import { getReturnById, recordReturnInspection, type InspectionStatus } from '../../../../lib/returns';

export const POST: APIRoute = async (context) => {
  const db = getDb();
  try {
    const user = await requireUser(context, db, ['packer']);
    requireOwnWarehouse(user, user.warehouse_id);
    const body = await context.request.json<{ returnId: string; status: InspectionStatus; labelImageKey?: string; productImageKey?: string }>();

    const existing = await getReturnById(db, body.returnId);
    if (!existing) return new Response(JSON.stringify({ error: 'Return not found' }), { status: 404 });
    if (existing.warehouseId !== user.warehouse_id) return new Response(JSON.stringify({ error: 'Not authorized for this warehouse' }), { status: 403 });

    await recordReturnInspection(db, body.returnId, user.id, body.status, {
      labelImageKey: body.labelImageKey,
      productImageKey: body.productImageKey
    });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 400 });
  }
};
