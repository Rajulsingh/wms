import type { APIRoute } from 'astro';
import { getDb, newId, logAudit } from '../../../lib/db';
import { requireUser, requireOwnWarehouse, AuthError } from '../../../lib/auth';

export const GET: APIRoute = async (context) => {
  const db = getDb();
  try {
    const user = await requireUser(context, db, ['admin']);
    const warehouseId = new URL(context.request.url).searchParams.get('warehouseId');
    requireOwnWarehouse(user, warehouseId);
    const rows = await db
      .prepare(
        `SELECT inv.id, inv.sku_id, inv.location_id, inv.quantity_on_hand, inv.quantity_reserved, inv.status,
                s.sku_code, s.name AS sku_name, s.price, s.image_url, s.msku,
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

/**
 * Direct correction of an on-hand count (a miscount, damage write-off,
 * spoilage, etc. found *outside* an active pick — a picker's own damage
 * report, see reportDamaged in lib/picker.ts, already handles the in-pick
 * case precisely) — not a reservation flow, sets the value outright and
 * logs who/what/before/after/why.
 *
 * `reason` is required, not optional: the only other place this app writes
 * off inventory (the picker's damage report) always carries one, and an
 * admin correction with no reason is exactly the kind of silent adjustment
 * that made two real incidents (COFFEE2, STNT-3A) hard to explain months
 * later — nothing recorded *why* a number changed, just that it did.
 *
 * Can never drop on-hand below quantity_reserved — those units are already
 * promised to a live pick_task; writing them off here would silently strand
 * that reservation against stock that no longer exists. Resolve the
 * order/pick first (report it damaged from the floor, or cancel the order),
 * then adjust.
 */
export const PATCH: APIRoute = async (context) => {
  const db = getDb();
  try {
    const user = await requireUser(context, db, ['admin']);
    const body = await context.request.json<{ inventoryId: string; quantityOnHand: number; reason: string }>();
    if (!Number.isFinite(body.quantityOnHand) || body.quantityOnHand < 0) {
      return new Response(JSON.stringify({ error: 'Quantity must be a non-negative number' }), { status: 400 });
    }
    const reason = body.reason?.trim();
    if (!reason) return new Response(JSON.stringify({ error: 'A reason is required for any manual stock correction' }), { status: 400 });

    const before = await db
      .prepare(`SELECT inv.quantity_on_hand, inv.quantity_reserved, loc.warehouse_id FROM inventory inv JOIN locations loc ON loc.id = inv.location_id WHERE inv.id = ?`)
      .bind(body.inventoryId)
      .first<{ quantity_on_hand: number; quantity_reserved: number; warehouse_id: string }>();
    if (!before) return new Response(JSON.stringify({ error: 'Inventory row not found' }), { status: 404 });
    requireOwnWarehouse(user, before.warehouse_id);
    if (body.quantityOnHand < before.quantity_reserved) {
      return new Response(
        JSON.stringify({ error: `Can't go below ${before.quantity_reserved} — that many units are already reserved for open orders at this location.` }),
        { status: 409 }
      );
    }

    await db
      .prepare(`UPDATE inventory SET quantity_on_hand = ?, version = version + 1, updated_at = datetime('now') WHERE id = ?`)
      .bind(body.quantityOnHand, body.inventoryId)
      .run();
    await logAudit(db, {
      userId: user.id,
      action: 'inventory.adjust',
      entityType: 'inventory',
      entityId: body.inventoryId,
      metadata: { before: before.quantity_on_hand, after: body.quantityOnHand, reason }
    });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};

/**
 * Retires an inventory row entirely — a bin/SKU combination that's done
 * (product discontinued at this location, bin decommissioned, or it was
 * created by mistake), not just at zero. Distinct from setting on-hand to 0
 * via PATCH: this removes the row so it stops appearing in receiving's
 * location picker and the stock table at all, rather than sitting there
 * forever as a stale zero-quantity line. Refuses while anything is still
 * reserved against it — same reasoning as the PATCH guard above, and the
 * same reason SKU merge/unmerge never delete a row outright (see
 * lib/skus.ts): an active reservation always has to be resolved first, not
 * silently orphaned by a cleanup action.
 */
export const DELETE: APIRoute = async (context) => {
  const db = getDb();
  try {
    const user = await requireUser(context, db, ['admin']);
    const body = await context.request.json<{ inventoryId: string }>();

    const row = await db
      .prepare(
        `SELECT inv.quantity_on_hand, inv.quantity_reserved, loc.warehouse_id, s.sku_code
         FROM inventory inv JOIN locations loc ON loc.id = inv.location_id JOIN skus s ON s.id = inv.sku_id
         WHERE inv.id = ?`
      )
      .bind(body.inventoryId)
      .first<{ quantity_on_hand: number; quantity_reserved: number; warehouse_id: string; sku_code: string }>();
    if (!row) return new Response(JSON.stringify({ error: 'Inventory row not found' }), { status: 404 });
    requireOwnWarehouse(user, row.warehouse_id);
    if (row.quantity_reserved > 0) {
      return new Response(JSON.stringify({ error: `Can't retire — ${row.quantity_reserved} units are still reserved for open orders here.` }), { status: 409 });
    }

    await db.prepare(`DELETE FROM inventory WHERE id = ?`).bind(body.inventoryId).run();
    await logAudit(db, {
      userId: user.id,
      action: 'inventory.retire',
      entityType: 'inventory',
      entityId: body.inventoryId,
      metadata: { skuCode: row.sku_code, quantityOnHand: row.quantity_on_hand }
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
    const user = await requireUser(context, db, ['admin']);
    const body = await context.request.json<{ skuId: string; locationId: string; quantityOnHand?: number }>();

    const location = await db.prepare(`SELECT warehouse_id FROM locations WHERE id = ?`).bind(body.locationId).first<{ warehouse_id: string }>();
    if (!location) return new Response(JSON.stringify({ error: 'Location not found' }), { status: 404 });
    requireOwnWarehouse(user, location.warehouse_id);

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
