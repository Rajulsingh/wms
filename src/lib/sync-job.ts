import { fetchUnfulfilledOrders } from './amazon';
import { importAmazonOrders, retryBlockedOrders } from './orders';
import { syncOrderStatuses } from './amazon-sync';

export interface SyncJobResult {
  warehouseId: string;
  imported: number;
  skipped: number;
  newSkusCreated: number;
  statusChecked: number;
  statusShipped: number;
  statusCancelled: number;
  retried: number;
  retrySucceeded: number;
}

/**
 * The automatic side of order handling — runs on a Cloudflare Cron Trigger
 * (see src/worker.ts) instead of only firing when an admin clicks "Import
 * from Amazon". Per warehouse: pulls new orders, then checks Amazon's
 * current status for every local Amazon order that isn't yet resolved (see
 * amazon-sync.ts for why that's a separate targeted call, not part of the
 * same pull), then retries reservation for anything still sitting blocked.
 *
 * That retry step matters more than it looks: `reserveOrderForPicking` at
 * import time is a one-shot attempt — if it fails, the order sits at
 * 'pending' until *something* retries it, and previously the only ways that
 * happened were an admin clicking "Retry blocked orders" or a picker's own
 * page polling (claimAvailableBatch's orphan-recovery in picker.ts, which
 * only fires while that page is actually open). A real incident showed the
 * gap this leaves: orders sat "blocked — short on stock" for a long stretch
 * even once real stock was available, because nobody had a picker page open
 * and nobody had clicked retry — not a stock problem, a nobody-retried-it
 * problem. Retrying here means it self-heals within one cron tick regardless
 * of whether any human or picker session happens to be active.
 *
 * Deliberately does NOT batch what it imports as a separate step — batching
 * happens via reserveOrderForPicking inside importAmazonOrders itself, and
 * this retry step covers anything that didn't succeed there. One warehouse's
 * failure doesn't stop the rest — this runs unattended, so a transient
 * SP-API error for one warehouse shouldn't silently starve every other
 * warehouse's sync too.
 */
export async function runAmazonSyncJob(db: D1Database): Promise<SyncJobResult[]> {
  const warehouses = await db.prepare(`SELECT id FROM warehouses`).all<{ id: string }>();
  const results: SyncJobResult[] = [];

  for (const wh of warehouses.results) {
    try {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const amazonOrders = await fetchUnfulfilledOrders(since);
      const importSummary = await importAmazonOrders(db, wh.id, amazonOrders);
      const statusResult = await syncOrderStatuses(db, wh.id);
      const retryResult = await retryBlockedOrders(db, wh.id);

      results.push({
        warehouseId: wh.id,
        imported: importSummary.imported,
        skipped: importSummary.skipped,
        newSkusCreated: importSummary.newSkusCreated.length,
        statusChecked: statusResult.checked,
        statusShipped: statusResult.shipped,
        statusCancelled: statusResult.cancelled,
        retried: retryResult.retried,
        retrySucceeded: retryResult.succeeded
      });
    } catch (err) {
      console.error(`Amazon sync job failed for warehouse ${wh.id}:`, err);
    }
  }

  return results;
}
