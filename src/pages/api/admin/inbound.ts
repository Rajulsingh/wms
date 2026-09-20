import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/db';
import { requireUser, AuthError } from '../../../lib/auth';
import { receiveStock, listReceipts, InboundError, type ReceiveLine } from '../../../lib/inbound';
import { suggestNextMsku } from '../../../lib/skus';

export const GET: APIRoute = async (context) => {
  const db = getDb();
  try {
    await requireUser(context, db, ['admin']);
    const warehouseId = new URL(context.request.url).searchParams.get('warehouseId');
    if (!warehouseId) return new Response(JSON.stringify({ error: 'warehouseId is required' }), { status: 400 });

    const [skus, locations, receipts, nextMsku] = await Promise.all([
      db
        .prepare(`SELECT id, sku_code, name, image_url, price, msku FROM skus WHERE merged_into_id IS NULL ORDER BY sku_code`)
        .all<{ id: string; sku_code: string; name: string; image_url: string | null; price: number | null; msku: string | null }>(),
      db
        .prepare(
          `SELECT loc.id, loc.code, z.name AS zone_name
           FROM locations loc LEFT JOIN zones z ON z.id = loc.zone_id
           WHERE loc.warehouse_id = ? AND loc.type = 'pickable'
           ORDER BY loc.sequence_number`
        )
        .bind(warehouseId)
        .all<{ id: string; code: string; zone_name: string | null }>(),
      listReceipts(db, warehouseId),
      suggestNextMsku(db)
    ]);

    return new Response(JSON.stringify({ skus: skus.results, locations: locations.results, receipts, nextMsku }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};

export const POST: APIRoute = async (context) => {
  const db = getDb();
  try {
    const user = await requireUser(context, db, ['admin']);
    const body = await context.request.json<{ warehouseId: string; reference?: string; lines: ReceiveLine[] }>();

    const result = await receiveStock(db, user.id, body.warehouseId, body.reference?.trim() || null, body.lines);
    return new Response(JSON.stringify(result), { status: 201, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    if (err instanceof InboundError) return new Response(JSON.stringify({ error: err.message, code: err.code }), { status: 409 });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};
