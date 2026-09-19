import type { APIRoute } from 'astro';
import { getDb, newId } from '../../../lib/db';
import { requireUser, AuthError } from '../../../lib/auth';

export const GET: APIRoute = async (context) => {
  const db = getDb();
  try {
    await requireUser(context, db, ['admin']);
    const warehouseId = new URL(context.request.url).searchParams.get('warehouseId');
    const rows = await db.prepare(`SELECT * FROM packing_stations WHERE warehouse_id = ? ORDER BY active DESC, code`).bind(warehouseId).all();
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
    const body = await context.request.json<{ warehouseId: string; code: string }>();
    const code = body.code.trim();
    if (!code) return new Response(JSON.stringify({ error: 'Station code is required' }), { status: 400 });

    const id = newId();
    const qrToken = `STATION-${code.toUpperCase().replace(/\s+/g, '-')}`;
    await db.prepare(`INSERT INTO packing_stations (id, warehouse_id, code, qr_token) VALUES (?, ?, ?, ?)`).bind(id, body.warehouseId, code, qrToken).run();
    return new Response(JSON.stringify({ id, code, qrToken }), { status: 201, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};

export const PATCH: APIRoute = async (context) => {
  const db = getDb();
  try {
    await requireUser(context, db, ['admin']);
    const body = await context.request.json<{ id: string; active: boolean }>();
    await db.prepare(`UPDATE packing_stations SET active = ? WHERE id = ?`).bind(body.active ? 1 : 0, body.id).run();
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};
