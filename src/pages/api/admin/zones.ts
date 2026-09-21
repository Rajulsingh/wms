import type { APIRoute } from 'astro';
import { getDb, newId } from '../../../lib/db';
import { requireUser, requireOwnWarehouse, AuthError } from '../../../lib/auth';

export const GET: APIRoute = async (context) => {
  const db = getDb();
  try {
    const user = await requireUser(context, db, ['admin']);
    const warehouseId = new URL(context.request.url).searchParams.get('warehouseId');
    requireOwnWarehouse(user, warehouseId);
    const rows = await db.prepare(`SELECT * FROM zones WHERE warehouse_id = ? ORDER BY sequence_number`).bind(warehouseId).all();
    return new Response(JSON.stringify(rows.results), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};

export const POST: APIRoute = async (context) => {
  const db = getDb();
  try {
    const user = await requireUser(context, db, ['admin']);
    const body = await context.request.json<{ warehouseId: string; name: string; sequenceNumber?: number }>();
    requireOwnWarehouse(user, body.warehouseId);
    const name = body.name.trim();
    if (!name) return new Response(JSON.stringify({ error: 'Zone name is required' }), { status: 400 });

    const id = newId();
    await db.prepare(`INSERT INTO zones (id, warehouse_id, name, sequence_number) VALUES (?, ?, ?, ?)`).bind(id, body.warehouseId, name, body.sequenceNumber ?? 0).run();
    return new Response(JSON.stringify({ id, name }), { status: 201, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};
