import type { APIRoute } from 'astro';
import { getDb } from '../../../../lib/db';
import { requireUser, AuthError } from '../../../../lib/auth';
import { getRatesForOrder, ShippingError } from '../../../../lib/shipping';

export const POST: APIRoute = async (context) => {
  const db = getDb();
  try {
    await requireUser(context, db, ['admin']);
    const body = await context.request.json<{ orderId: string; boxSizeId: string; weightValue: number; weightUnit: string }>();

    const rates = await getRatesForOrder(db, body.orderId, body.boxSizeId, body.weightValue, body.weightUnit);
    return new Response(JSON.stringify(rates), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    if (err instanceof ShippingError) return new Response(JSON.stringify({ error: err.message, code: err.code }), { status: 409 });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};
