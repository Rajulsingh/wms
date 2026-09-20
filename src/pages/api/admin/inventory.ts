import type { APIRoute } from 'astro';
import { getDb, newId, logAudit } from '../../../lib/db';
import { requireUser, AuthError } from '../../../lib/auth';

export const GET: APIRoute = async (context) => {
  const db = getDb();
  try {
    await requireUser(context, db, ['admin']);
    const warehouseId = new URL(context.request.url).searchParams.get('warehouseId');
    const rows = await db
      .prepare(
        `SELECT inv.id, inv.sku_id, inv.location_id, inv.quantity_on_hand, inv.quantity_reserved, inv.status,
                s.sku_code, s.name AS sku_name, s.price, s.image_url, s.efnsku,
                loc.code AS location_code, z.name AS zone_name
         FROM inventory inv
         JOIN skus s ON s.id = inv.sku_id
         JOIN locations loc ON loc.id = inv.location_id
         LEFT JOIN zones z ON z.id = loc.zone_id
         WHERE loc.warehouse_id = ?
         ORDER BY s.sku_code, loc.sequence_number`
      )
      .bind(warehouseId)
      .all();
    return new Response(JSON.stringify(rows.results), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};

/** Direct correction of an on-hand count (a miscount, damage write-off, etc.) — not a reservation flow, sets the value outright and logs who/what/before/after. */
export const PATCH: APIRoute = async (context) => {
  const db = getDb();
  try {
    const user = await requireUser(context, db, ['admin']);
    const body = await context.request.json<{ inventoryId: string; quantityOnHand: number }>();
    if (!Number.isFinite(body.quantityOnHand) || body.quantityOnHand < 0) {
      return new Response(JSON.stringify({ error: 'Quantity must be a non-negative number' }), { status: 400 });
    }

    const before = await db.prepare(`SELECT quantity_on_hand FROM inventory WHERE id = ?`).bind(body.inventoryId).first<{ quantity_on_hand: number }>();
    if (!before) return new Response(JSON.stringify({ error: 'Inventory row not found' }), { status: 404 });

    await db
      .prepare(`UPDATE inventory SET quantity_on_hand = ?, version = version + 1, updated_at = datetime('now') WHERE id = ?`)
      .bind(body.quantityOnHand, body.inventoryId)
      .run();
    await logAudit(db, {
      userId: user.id,
      action: 'inventory.adjust',
      entityType: 'inventory',
      entityId: body.inventoryId,
      metadata: { before: before.quantity_on_hand, after: body.quantityOnHand }
    });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};

/** Creates a zero-reservation inventory row for a SKU at a location that doesn't have one yet (so it shows up to adjust/receive into). */
export const POST: APIRoute = async (context) => {
  const db = getDb();
  try {
    await requireUser(context, db, ['admin']);
    const body = await context.request.json<{ skuId: string; locationId: string; quantityOnHand?: number }>();

    const existing = await db.prepare(`SELECT id FROM inventory WHERE sku_id = ? AND location_id = ?`).bind(body.skuId, body.locationId).first<{ id: string }>();
    if (existing) return new Response(JSON.stringify({ error: 'This SKU already has an inventory row at that location' }), { status: 409 });

    const id = newId();
    await db
      .prepare(`INSERT INTO inventory (id, sku_id, location_id, quantity_on_hand) VALUES (?, ?, ?, ?)`)
      .bind(id, body.skuId, body.locationId, body.quantityOnHand ?? 0)
      .run();
    return new Response(JSON.stringify({ id }), { status: 201, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};
