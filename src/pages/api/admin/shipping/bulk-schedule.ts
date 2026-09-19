import type { APIRoute } from 'astro';
import { getDb } from '../../../../lib/db';
import { requireUser, AuthError } from '../../../../lib/auth';
import { scheduleEasyShipBulk, ShippingError, type BulkScheduleOrderInput } from '../../../../lib/shipping';
import type { HandoverSlot } from '../../../../lib/amazon';

export const POST: APIRoute = async (context) => {
  const db = getDb();
  try {
    const user = await requireUser(context, db, ['admin']);
    const body = await context.request.json<{
      orders: BulkScheduleOrderInput[];
      slot?: Pick<HandoverSlot, 'slotId' | 'startTime' | 'endTime' | 'handoverMethod'>;
    }>();

    if (!body.orders?.length) {
      return new Response(JSON.stringify({ error: 'Select at least one order' }), { status: 400 });
    }
    if (body.orders.some((o) => !o.packageIdentifier?.trim())) {
      return new Response(JSON.stringify({ error: 'Every order needs a package identifier' }), { status: 400 });
    }

    const result = await scheduleEasyShipBulk(db, user.id, body.orders, body.slot);
    return new Response(JSON.stringify(result), { status: 201, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    if (err instanceof ShippingError) return new Response(JSON.stringify({ error: err.message, code: err.code }), { status: 409 });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};
