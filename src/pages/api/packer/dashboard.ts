import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/db';
import { requireUser, requireOwnWarehouse, AuthError } from '../../../lib/auth';
import { getMyActiveBatches, getPickListView } from '../../../lib/picker';
import { getUnbatchedOrderSummary } from '../../../lib/orders';
import { getPackerDailySummary } from '../../../lib/packer';

// Read-only — unlike /api/picker/claim-batch, this never auto-claims a new
// batch. It's the packer's own dashboard: what's already assigned to them,
// and what this packer has actually finished today. "What's waiting but not
// yet claimed" moved to the shared /api/picker/sku-demand (see picker.ts's
// getUnassignedSkuDemand) — the same endpoint the admin bulk-assign screen
// uses, so the two views can never disagree.
export const GET: APIRoute = async (context) => {
  const db = getDb();
  try {
    const user = await requireUser(context, db, ['packer']);
    const warehouseId = new URL(context.request.url).searchParams.get('warehouseId');
    requireOwnWarehouse(user, warehouseId);

    const myBatchIds = await getMyActiveBatches(db, warehouseId, user.id);
    const myBatches = [];
    for (const batchId of myBatchIds) {
      const rows = await getPickListView(db, batchId);
      myBatches.push({
        batchId,
        orderCount: new Set(rows.map((r) => r.external_order_id)).size,
        skuCount: new Set(rows.map((r) => r.sku_code)).size,
        remaining: rows.filter((r) => r.status === 'pending').length
      });
    }

    const unbatched = await getUnbatchedOrderSummary(db, warehouseId);
    const today = await getPackerDailySummary(db, warehouseId, user.id);

    return new Response(JSON.stringify({ myBatches, unbatched, today }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};
