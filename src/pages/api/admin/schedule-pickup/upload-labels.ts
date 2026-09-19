import type { APIRoute } from 'astro';
import { getDb } from '../../../../lib/db';
import { requireUser, AuthError } from '../../../../lib/auth';
import { processUploadedLabelPdf, base64ToBytes, SchedulePickupError } from '../../../../lib/schedule-pickup';

export const POST: APIRoute = async (context) => {
  const db = getDb();
  try {
    const user = await requireUser(context, db, ['admin']);
    const body = await context.request.json<{ warehouseId: string; batchId: string; pdfBase64: string }>();

    if (!body.pdfBase64) {
      return new Response(JSON.stringify({ error: 'No PDF provided' }), { status: 400 });
    }

    const result = await processUploadedLabelPdf(db, user.id, body.warehouseId, body.batchId, base64ToBytes(body.pdfBase64));
    return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    if (err instanceof SchedulePickupError) return new Response(JSON.stringify({ error: err.message, code: err.code }), { status: 409 });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};
