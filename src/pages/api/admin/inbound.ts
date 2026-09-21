import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/db';
import { requireUser, requireOwnWarehouse, AuthError } from '../../../lib/auth';
import { receiveStock, listReceipts, InboundError, type ReceiveLine } from '../../../lib/inbound';
import { suggestNextMsku } from '../../../lib/skus';
import { getOrganizationIdForWarehouse } from '../../../lib/org-accounts';

export const GET: APIRoute = async (context) => {
  const db = getDb();
  try {
    const user = await requireUser(context, db, ['admin']);
    const warehouseId = new URL(context.request.url).searchParams.get('warehouseId');
    requireOwnWarehouse(user, warehouseId);
    const organizationId = await getOrganizationIdForWarehouse(db, warehouseId!);

    const [skus, locations, receipts, nextMsku] = await Promise.all([
      // Only active (buyable) listings are selectable here — a parent/inactive
      // listing (is_parent_asin = 1) holds no real inventory on Amazon and can
      // never be ordered, so it must never be the target of a stock receipt.
      // Excluding it here (rather than only from duplicate-scan, see skus.ts)
      // is what actually stops it from becoming a live inventory row in the
      // first place. Scoped to this warehouse's own organization — see
      // migrations/0026_skus_per_organization.sql.
      db
        .prepare(`SELECT id, sku_code, name, image_url, price, msku FROM skus WHERE organization_id = ? AND merged_into_id IS NULL AND is_parent_asin = 0 ORDER BY sku_code`)
        .bind(organizationId)
        .all<{ id: string; sku_code: string; name: string; image_url: string | null; price: number | null; msku: string | null }>(),
      db
        .prepare(
          `SELECT loc.id, loc.code, z.name AS zone_name
           FROM locations loc LEFT JOIN zones z ON z.id = loc.zone_id
           WHERE loc.warehouse_id = ? AND loc.type = 'pickable'
           ORDER BY loc.sequence_number`
        )
        .bind(warehouseId)
        .all<{ id: string; code: string; zone_name: string | null }>(),
      listReceipts(db, warehouseId),
      suggestNextMsku(db, organizationId)
    ]);

    return new Response(JSON.stringify({ skus: skus.results, locations: locations.results, receipts, nextMsku }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};

export const POST: APIRoute = async (context) => {
  const db = getDb();
  try {
    const user = await requireUser(context, db, ['admin']);
    const body = await context.request.json<{ warehouseId: string; reference?: string; lines: ReceiveLine[] }>();
    requireOwnWarehouse(user, body.warehouseId);

    const result = await receiveStock(db, user.id, body.warehouseId, body.reference?.trim() || null, body.lines);
    return new Response(JSON.stringify(result), { status: 201, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    if (err instanceof InboundError) return new Response(JSON.stringify({ error: err.message, code: err.code }), { status: 409 });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};
