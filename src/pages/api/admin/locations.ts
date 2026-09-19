import type { APIRoute } from 'astro';
import { getDb, newId } from '../../../lib/db';
import { requireUser, AuthError } from '../../../lib/auth';

export const GET: APIRoute = async (context) => {
  const db = getDb();
  try {
    await requireUser(context, db, ['admin']);
    const warehouseId = new URL(context.request.url).searchParams.get('warehouseId');
    const rows = await db
      .prepare(
        `SELECT loc.*, z.name AS zone_name FROM locations loc LEFT JOIN zones z ON z.id = loc.zone_id
         WHERE loc.warehouse_id = ? ORDER BY loc.sequence_number`
      )
      .bind(warehouseId)
      .all();
    return new Response(JSON.stringify(rows.results), { status: 200, headers: { 'Content-Type': 'application/json' } });
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
      zoneId?: string;
      code: string;
      type?: 'pickable' | 'reserve';
      sequenceNumber?: number;
    }>();
    const code = body.code.trim();
    if (!code) return new Response(JSON.stringify({ error: 'Location code is required' }), { status: 400 });

    const existing = await db.prepare(`SELECT id FROM locations WHERE warehouse_id = ? AND code = ?`).bind(body.warehouseId, code).first<{ id: string }>();
    if (existing) return new Response(JSON.stringify({ error: `"${code}" already exists in this warehouse.` }), { status: 409 });

    const id = newId();
    const qrToken = `LOC-${code.toUpperCase().replace(/\s+/g, '-')}`;
    await db
      .prepare(`INSERT INTO locations (id, warehouse_id, zone_id, code, type, sequence_number, qr_token) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, body.warehouseId, body.zoneId ?? null, code, body.type ?? 'pickable', body.sequenceNumber ?? 0, qrToken)
      .run();
    return new Response(JSON.stringify({ id, code, qrToken }), { status: 201, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};
