import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/db';
import { requireUser, requireOwnWarehouse, AuthError } from '../../../lib/auth';
import { applyAwbByScan, PackerFlowError } from '../../../lib/packer';

// Matched against Amazon's own known AWB-to-order data first, FIFO only as a
// fallback — see applyAwbByScan in lib/packer.ts.
export const POST: APIRoute = async (context) => {
  const db = getDb();
  try {
    const user = await requireUser(context, db, ['packer']);
    const body = await context.request.json<{ warehouseId: string; awbCode: string }>();
    requireOwnWarehouse(user, body.warehouseId);

    const result = await applyAwbByScan(db, user.id, body.warehouseId, body.awbCode);
    return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    if (err instanceof PackerFlowError) return new Response(JSON.stringify({ error: err.message, code: err.code }), { status: 409 });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};
