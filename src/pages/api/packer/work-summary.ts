import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/db';
import { requireUser, AuthError } from '../../../lib/auth';

/**
 * Lightweight poll target for the pick/pack tab notification dots — counts
 * of work waiting in each queue, nothing else. Never selects price (packers
 * must never see it, see picker.ts/packer.ts queries — intentional
 * omission, not an oversight).
 */
export const GET: APIRoute = async (context) => {
  const db = getDb();
  try {
    await requireUser(context, db, ['packer']);
    const warehouseId = new URL(context.request.url).searchParams.get('warehouseId');

    const pickable = await db
      .prepare(`SELECT COUNT(*) AS c FROM pick_batches WHERE warehouse_id = ? AND status IN ('pending', 'assigned')`)
      .bind(warehouseId)
      .first<{ c: number }>();
    const packable = await db
      .prepare(`SELECT COUNT(*) AS c FROM orders WHERE warehouse_id = ? AND status = 'picked'`)
      .bind(warehouseId)
      .first<{ c: number }>();

    return new Response(JSON.stringify({ pickable: pickable?.c ?? 0, packable: packable?.c ?? 0 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};
