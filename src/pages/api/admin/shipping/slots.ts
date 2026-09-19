import type { APIRoute } from 'astro';
import { getDb } from '../../../../lib/db';
import { requireUser, AuthError } from '../../../../lib/auth';
import { getHandoverSlotsForOrder, ShippingError } from '../../../../lib/shipping';

export const POST: APIRoute = async (context) => {
  const db = getDb();
  try {
    await requireUser(context, db, ['admin']);
    const body = await context.request.json<{ orderId: string; boxSizeId: string; weightGrams: number }>();

    const slots = await getHandoverSlotsForOrder(db, body.orderId, body.boxSizeId, body.weightGrams);
    return new Response(JSON.stringify(slots), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    if (err instanceof ShippingError) return new Response(JSON.stringify({ error: err.message, code: err.code }), { status: 409 });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};
