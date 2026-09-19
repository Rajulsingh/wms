import type { APIRoute } from 'astro';
import { getDb } from '../../../../lib/db';
import { requireUser, AuthError } from '../../../../lib/auth';
import { scheduleEasyShipForOrder, ShippingError } from '../../../../lib/shipping';
import type { HandoverSlot } from '../../../../lib/amazon';

export const POST: APIRoute = async (context) => {
  const db = getDb();
  try {
    const user = await requireUser(context, db, ['admin']);
    const body = await context.request.json<{
      orderId: string;
      boxSizeId: string;
      weightValue: number;
      weightUnit: string;
      slot: Pick<HandoverSlot, 'slotId' | 'startTime' | 'endTime' | 'handoverMethod'>;
      packageIdentifier: string;
    }>();

    if (!body.packageIdentifier?.trim()) {
      return new Response(JSON.stringify({ error: 'Package identifier is required — this prints on the label.' }), { status: 400 });
    }

    const result = await scheduleEasyShipForOrder(
      db,
      user.id,
      body.orderId,
      body.boxSizeId,
      body.weightValue,
      body.weightUnit,
      body.slot,
      body.packageIdentifier.trim()
    );
    return new Response(JSON.stringify(result), { status: 201, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    if (err instanceof ShippingError) return new Response(JSON.stringify({ error: err.message, code: err.code }), { status: 409 });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};
