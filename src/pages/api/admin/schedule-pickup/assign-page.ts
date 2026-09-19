import type { APIRoute } from 'astro';
import { getDb } from '../../../../lib/db';
import { requireUser, AuthError } from '../../../../lib/auth';
import { assignPageManually, base64ToBytes, SchedulePickupError } from '../../../../lib/schedule-pickup';

export const POST: APIRoute = async (context) => {
  const db = getDb();
  try {
    const user = await requireUser(context, db, ['admin']);
    const body = await context.request.json<{ warehouseId: string; batchId: string; orderId: string; pdfBase64: string; pageIndices: number[] }>();

    if (!body.orderId || !body.pageIndices?.length) {
      return new Response(JSON.stringify({ error: 'Select an order and at least one page' }), { status: 400 });
    }

    await assignPageManually(db, user.id, body.warehouseId, body.batchId, body.orderId, base64ToBytes(body.pdfBase64), body.pageIndices);
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    if (err instanceof SchedulePickupError) return new Response(JSON.stringify({ error: err.message, code: err.code }), { status: 409 });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};
