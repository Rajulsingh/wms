import { fetchUnfulfilledOrders } from './amazon';
import { importAmazonOrders, autoBatchNewOrders } from './orders';
import { syncOrderStatuses } from './amazon-sync';

export interface SyncJobResult {
  warehouseId: string;
  imported: number;
  skipped: number;
  newSkusCreated: number;
  batched: number;
  statusChecked: number;
  statusShipped: number;
  statusCancelled: number;
}

/**
 * The automatic side of order handling — runs on a Cloudflare Cron Trigger
 * (see src/worker.ts) instead of only firing when an admin clicks "Import
 * from Amazon". Per warehouse: pulls new orders, auto-batches them, then
 * checks Amazon's current status for every local Amazon order that isn't
 * yet resolved (see amazon-sync.ts for why that's a separate targeted call,
 * not part of the same pull). One warehouse's failure doesn't stop the rest
 * — this runs unattended, so a transient SP-API error for one warehouse
 * shouldn't silently starve every other warehouse's sync too.
 */
export async function runAmazonSyncJob(db: D1Database): Promise<SyncJobResult[]> {
  const warehouses = await db.prepare(`SELECT id FROM warehouses`).all<{ id: string }>();
  const results: SyncJobResult[] = [];

  for (const wh of warehouses.results) {
    try {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const amazonOrders = await fetchUnfulfilledOrders(since);
      const importSummary = await importAmazonOrders(db, wh.id, amazonOrders);
      const batch = importSummary.imported > 0 ? await autoBatchNewOrders(db, wh.id) : null;
      const statusResult = await syncOrderStatuses(db, wh.id);

      results.push({
        warehouseId: wh.id,
        imported: importSummary.imported,
        skipped: importSummary.skipped,
        newSkusCreated: importSummary.newSkusCreated.length,
        batched: batch?.orderCount ?? 0,
        statusChecked: statusResult.checked,
        statusShipped: statusResult.shipped,
        statusCancelled: statusResult.cancelled
      });
    } catch (err) {
      console.error(`Amazon sync job failed for warehouse ${wh.id}:`, err);
    }
  }

  return results;
}
