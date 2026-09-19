import type { APIRoute } from 'astro';
import { getDb } from '../../../../lib/db';
import { requireUser, AuthError } from '../../../../lib/auth';
import { createScheduleBatch, generateScheduleFile, SchedulePickupError, type ScheduleOrderInput } from '../../../../lib/schedule-pickup';

export const POST: APIRoute = async (context) => {
  const db = getDb();
  try {
    const user = await requireUser(context, db, ['admin']);
    const body = await context.request.json<{
      warehouseId: string;
      pickupDate: string;
      pickupTime: '11:00 AM' | '2:00 PM';
      orders: ScheduleOrderInput[];
    }>();

    if (!body.orders?.length) {
      return new Response(JSON.stringify({ error: 'Select at least one order' }), { status: 400 });
    }
    if (body.orders.some((o) => !o.invoiceId?.trim())) {
      return new Response(JSON.stringify({ error: 'Every order needs an invoice id' }), { status: 400 });
    }

    const batchId = await createScheduleBatch(db, user.id, body.warehouseId, body.pickupDate, body.pickupTime);
    const result = await generateScheduleFile(db, user.id, body.warehouseId, batchId, body.orders);
    return new Response(JSON.stringify(result), { status: 201, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    if (err instanceof SchedulePickupError) return new Response(JSON.stringify({ error: err.message, code: err.code }), { status: 409 });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};
