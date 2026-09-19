import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/db';
import { requireUser, AuthError } from '../../../lib/auth';

export const GET: APIRoute = async (context) => {
  const db = getDb();
  try {
    await requireUser(context, db, ['admin']);
    const warehouseId = new URL(context.request.url).searchParams.get('warehouseId');
    const w = await db.prepare(`SELECT * FROM warehouses WHERE id = ?`).bind(warehouseId).first();
    return new Response(JSON.stringify(w), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};

export const POST: APIRoute = async (context) => {
  const db = getDb();
  try {
    await requireUser(context, db, ['admin']);
    const body = await context.request.json<{
      warehouseId: string;
      shipFromName: string;
      shipFromAddressLine1: string;
      shipFromCity: string;
      shipFromState: string;
      shipFromPostalCode: string;
      shipFromCountryCode: string;
      shipFromPhone: string;
      shipFromEmail?: string;
    }>();

    await db
      .prepare(
        `UPDATE warehouses SET
           ship_from_name = ?, ship_from_address_line1 = ?, ship_from_city = ?, ship_from_state = ?,
           ship_from_postal_code = ?, ship_from_country_code = ?, ship_from_phone = ?, ship_from_email = ?
         WHERE id = ?`
      )
      .bind(
        body.shipFromName,
        body.shipFromAddressLine1,
        body.shipFromCity,
        body.shipFromState,
        body.shipFromPostalCode,
        body.shipFromCountryCode,
        body.shipFromPhone,
        body.shipFromEmail ?? null,
        body.warehouseId
      )
      .run();
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};
