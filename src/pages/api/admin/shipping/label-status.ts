import type { APIRoute } from 'astro';
import { getDb } from '../../../../lib/db';
import { requireUser, AuthError } from '../../../../lib/auth';
import { checkLabelStatus, retryLabelRequest, ShippingError } from '../../../../lib/shipping';

export const GET: APIRoute = async (context) => {
  const db = getDb();
  try {
    await requireUser(context, db, ['admin']);
    const shipmentId = new URL(context.request.url).searchParams.get('shipmentId');
    if (!shipmentId) return new Response(JSON.stringify({ error: 'shipmentId is required' }), { status: 400 });

    const result = await checkLabelStatus(db, shipmentId);
    return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    if (err instanceof ShippingError) return new Response(JSON.stringify({ error: err.message, code: err.code }), { status: 409 });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};

export const POST: APIRoute = async (context) => {
  const db = getDb();
  try {
    await requireUser(context, db, ['admin']);
    const body = await context.request.json<{ shipmentId: string }>();

    await retryLabelRequest(db, body.shipmentId);
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    if (err instanceof ShippingError) return new Response(JSON.stringify({ error: err.message, code: err.code }), { status: 409 });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};
