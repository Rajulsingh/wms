import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/db';
import { requireUser, AuthError } from '../../../lib/auth';
import { getMyActiveBatches, getUpcomingBatches, getPickListView } from '../../../lib/picker';

// Read-only — unlike /api/picker/claim-batch, this never auto-claims a new
// batch. It's the packer's own dashboard: what's already assigned to them,
// plus visibility into work admin has pulled but nobody has claimed yet.
export const GET: APIRoute = async (context) => {
  const db = getDb();
  try {
    const user = await requireUser(context, db, ['packer']);
    const warehouseId = new URL(context.request.url).searchParams.get('warehouseId');
    if (!warehouseId) return new Response(JSON.stringify({ error: 'warehouseId required' }), { status: 400 });

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

    const upcoming = await getUpcomingBatches(db, warehouseId);

    return new Response(JSON.stringify({ myBatches, upcoming }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};
