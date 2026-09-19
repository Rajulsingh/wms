import type { APIRoute } from 'astro';
import { getDb, newId } from '../../../lib/db';
import { requireUser, AuthError, hashPin } from '../../../lib/auth';
import type { UserRole } from '../../../lib/types';

export const GET: APIRoute = async (context) => {
  const db = getDb();
  try {
    await requireUser(context, db, ['admin']);
    const warehouseId = new URL(context.request.url).searchParams.get('warehouseId');
    const rows = await db
      .prepare(`SELECT id, name, role, active, station_id, created_at FROM users WHERE warehouse_id = ? ORDER BY active DESC, role, name`)
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
    const body = await context.request.json<{ warehouseId: string; name: string; role: UserRole; pin: string }>();

    const name = body.name.trim();
    if (!name) return new Response(JSON.stringify({ error: 'Name is required' }), { status: 400 });
    if (!/^\d{4,8}$/.test(body.pin)) return new Response(JSON.stringify({ error: 'PIN must be 4-8 digits' }), { status: 400 });
    if (body.role !== 'admin' && body.role !== 'packer') return new Response(JSON.stringify({ error: 'Role must be admin or packer' }), { status: 400 });

    const existing = await db.prepare(`SELECT id FROM users WHERE name = ?`).bind(name).first<{ id: string }>();
    if (existing) return new Response(JSON.stringify({ error: `"${name}" is already in use — names must be unique per person.` }), { status: 409 });

    const id = newId();
    await db
      .prepare(`INSERT INTO users (id, warehouse_id, name, role, pin_hash) VALUES (?, ?, ?, ?, ?)`)
      .bind(id, body.warehouseId, name, body.role, await hashPin(body.pin))
      .run();
    return new Response(JSON.stringify({ id, name, role: body.role }), { status: 201, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};

/**
 * Deactivate/reactivate and/or reassign a packer's station — never a hard
 * delete for the former, so audit history (which references user_id) stays
 * intact. `stationId` (including explicit `null` to unassign) is separate
 * from `active` so the Users page can save one without touching the other.
 */
export const PATCH: APIRoute = async (context) => {
  const db = getDb();
  try {
    const requester = await requireUser(context, db, ['admin']);
    const body = await context.request.json<{ userId: string; active?: boolean; stationId?: string | null }>();
    if (body.active !== undefined) {
      if (body.userId === requester.id && !body.active) {
        return new Response(JSON.stringify({ error: "You can't deactivate your own account while logged in as it." }), { status: 400 });
      }
      await db.prepare(`UPDATE users SET active = ? WHERE id = ?`).bind(body.active ? 1 : 0, body.userId).run();
    }
    if (body.stationId !== undefined) {
      await db.prepare(`UPDATE users SET station_id = ? WHERE id = ?`).bind(body.stationId, body.userId).run();
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};
