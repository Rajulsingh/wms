import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/db';
import { requireUser, AuthError } from '../../../lib/auth';

/** Lets the packer pick a station from a short list instead of typing its QR token — a legitimate fallback (not just a test shortcut) when a handful of physical stations is small enough to pick from, same spirit as the barcode/QR fallback elsewhere. */
export const GET: APIRoute = async (context) => {
  const db = getDb();
  try {
    await requireUser(context, db, ['packer']);
    const warehouseId = new URL(context.request.url).searchParams.get('warehouseId');
    const stations = await db
      .prepare(`SELECT id, code, qr_token FROM packing_stations WHERE warehouse_id = ? AND active = 1 ORDER BY code`)
      .bind(warehouseId)
      .all();
    return new Response(JSON.stringify(stations.results), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};
