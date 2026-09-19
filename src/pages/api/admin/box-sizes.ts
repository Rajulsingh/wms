import type { APIRoute } from 'astro';
import { getDb, newId } from '../../../lib/db';
import { requireUser, AuthError } from '../../../lib/auth';

export const GET: APIRoute = async (context) => {
  const db = getDb();
  try {
    await requireUser(context, db, ['admin']);
    const warehouseId = new URL(context.request.url).searchParams.get('warehouseId');
    const rows = await db
      .prepare(`SELECT * FROM box_sizes WHERE warehouse_id = ? AND active = 1 ORDER BY name`)
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
      name: string;
      length: number;
      width: number;
      height: number;
      dimensionUnit?: 'centimeters' | 'inches';
    }>();

    const id = newId();
    await db
      .prepare(`INSERT INTO box_sizes (id, warehouse_id, name, length, width, height, dimension_unit) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, body.warehouseId, body.name, body.length, body.width, body.height, body.dimensionUnit ?? 'centimeters')
      .run();
    return new Response(JSON.stringify({ id }), { status: 201, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};
