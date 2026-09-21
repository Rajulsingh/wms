import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/db';
import { requireUser, AuthError } from '../../../lib/auth';
import { getOrganizationIdForWarehouse } from '../../../lib/org-accounts';

const DEFAULT_REORDER_POINT = 5;

/**
 * Rolls up everything the inventory reports dashboard needs into one call:
 * current stock per SKU, low-stock flags, and pick-based outbound/velocity
 * numbers. "Outbound" here means units picked (physically left the shelf,
 * `pick_tasks.picked_at`) — the closest proxy this schema has to a ship
 * date; there's no separate per-unit ship-confirmation timestamp. If the
 * user wants true ship-date tracking later, that needs a new column, not a
 * different query over what's here.
 */
export const GET: APIRoute = async (context) => {
  const db = getDb();
  try {
    await requireUser(context, db, ['admin']);
    const warehouseId = new URL(context.request.url).searchParams.get('warehouseId');
    if (!warehouseId) return new Response(JSON.stringify({ error: 'warehouseId is required' }), { status: 400 });
    const organizationId = await getOrganizationIdForWarehouse(db, warehouseId);

    // `WHERE s.organization_id = ?` is the fix for a real cross-tenant leak
    // (migrations/0026_skus_per_organization.sql): this used to drive FROM
    // skus with no organization filter at all, so every seller's stock
    // report listed every OTHER seller's SKUs too (with 0 on-hand for ones
    // the LEFT JOIN on warehouse-scoped `loc` didn't match) — confirmed live
    // while testing onboarding, not theoretical.
    const stock = await db
      .prepare(
        `SELECT s.id AS sku_id, s.sku_code, s.name AS sku_name, s.reorder_point,
                COALESCE(SUM(inv.quantity_on_hand), 0) AS on_hand,
                COALESCE(SUM(inv.quantity_reserved), 0) AS reserved
         FROM skus s
         LEFT JOIN inventory inv ON inv.sku_id = s.id
         LEFT JOIN locations loc ON loc.id = inv.location_id AND loc.warehouse_id = ?
         WHERE s.organization_id = ? AND s.merged_into_id IS NULL
         GROUP BY s.id
         ORDER BY s.sku_code`
      )
      .bind(warehouseId, organizationId)
      .all<{ sku_id: string; sku_code: string; sku_name: string; reorder_point: number | null; on_hand: number; reserved: number }>();

    const dailyPicks = await db
      .prepare(
        `SELECT s.sku_code, DATE(pt.picked_at) AS pick_date, SUM(pt.quantity_picked) AS units
         FROM pick_tasks pt
         JOIN skus s ON s.id = pt.sku_id
         JOIN pick_batches pb ON pb.id = pt.pick_batch_id
         WHERE pb.warehouse_id = ? AND pt.picked_at IS NOT NULL AND pt.picked_at >= datetime('now', '-30 days')
         GROUP BY s.sku_code, DATE(pt.picked_at)
         ORDER BY pick_date DESC`
      )
      .bind(warehouseId)
      .all<{ sku_code: string; pick_date: string; units: number }>();

    const velocity = await db
      .prepare(
        `SELECT s.sku_code,
                SUM(CASE WHEN pt.picked_at >= datetime('now', '-7 days') THEN pt.quantity_picked ELSE 0 END) AS units_7d,
                SUM(CASE WHEN pt.picked_at >= datetime('now', '-30 days') THEN pt.quantity_picked ELSE 0 END) AS units_30d
         FROM pick_tasks pt
         JOIN skus s ON s.id = pt.sku_id
         JOIN pick_batches pb ON pb.id = pt.pick_batch_id
         WHERE pb.warehouse_id = ? AND pt.picked_at IS NOT NULL
         GROUP BY s.sku_code`
      )
      .bind(warehouseId)
      .all<{ sku_code: string; units_7d: number; units_30d: number }>();

    const velocityBySku = new Map(velocity.results.map((v) => [v.sku_code, v]));

    const stockRows = stock.results.map((r) => {
      const threshold = r.reorder_point ?? DEFAULT_REORDER_POINT;
      const available = r.on_hand - r.reserved;
      return {
        ...r,
        available,
        lowStock: available <= threshold,
        threshold,
        units_7d: velocityBySku.get(r.sku_code)?.units_7d ?? 0,
        units_30d: velocityBySku.get(r.sku_code)?.units_30d ?? 0
      };
    });

    return new Response(
      JSON.stringify({
        stock: stockRows,
        dailyPicks: dailyPicks.results,
        lowStock: stockRows.filter((r) => r.lowStock)
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};
