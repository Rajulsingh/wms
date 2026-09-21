import { fetchUnfulfilledOrders } from './amazon';
import { importAmazonOrders, retryBlockedOrders } from './orders';
import { syncOrderStatuses } from './amazon-sync';
import { resolveAmazonCredentials, NOT_CONNECTED } from './org-accounts';

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
  shortOrders: Array<{ orderId: string; reason: string }>;
}

/**
 * The automatic side of order handling — runs on a Cloudflare Cron Trigger
 * (see src/worker.ts) instead of only firing when an admin clicks "Sync with
 * Amazon". Per warehouse: pulls new orders, then checks Amazon's
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
 *
 * This used to be two separate admin actions — "Import from Amazon" (just
 * the pull, one warehouse, 72h lookback) and a "sync" concept that also did
 * the status-check/retry — which genuinely did overlap (both pulled new
 * orders) and confused more than they helped. Now there's exactly one
 * import path, this one; `sinceHours` is only ever a *fallback*, used solely
 * when a warehouse has no persisted watermark yet (see below) — the cron
 * passes its own tight 24h fallback, a manual trigger (api/admin/sync-now.ts,
 * api/picker/sync-now.ts) passes a wider 72h one, since a human clicking a
 * button by hand wants a generous first catch-up, not the assumption that
 * the last automatic tick was recent.
 *
 * The lookback itself is a persisted per-warehouse high-water mark
 * (`warehouses.amazon_orders_synced_through`, migration 0024), not a fixed
 * rolling window from `sinceHours` — real incident (see HANDOFF.md): an
 * order that goes quiet on Amazon's side (scheduled once, then genuinely
 * just sits with no further status change) for longer than a fixed window
 * falls out of `fetchUnfulfilledOrders`'s `LastUpdatedAfter` reach
 * *permanently*, since nothing ever re-checks further back regardless of how
 * long it keeps sitting there. The watermark self-heals instead: captured
 * just *before* this run's own GetOrders call (not after — an order updated
 * mid-run must still be caught by the *next* run, not skipped because the
 * watermark already moved past it), and only advanced once the fetch+import
 * for this warehouse actually succeeds. A gap (cron down for a day, nobody
 * logging in for a week) is caught in full on the next successful run,
 * however long it's been, with no ever-wider fixed window needed. One
 * warehouse's failure leaves its watermark untouched, so it naturally
 * retries the same range next time — safe, since `importAmazonOrders`
 * dedupes by external order id regardless.
 */
export async function runAmazonSyncJob(db: D1Database, sinceHours = 24): Promise<SyncJobResult[]> {
  const warehouses = await db
    .prepare(`SELECT id, amazon_orders_synced_through, organization_id FROM warehouses`)
    .all<{ id: string; amazon_orders_synced_through: string | null; organization_id: string | null }>();
  const results: SyncJobResult[] = [];

  for (const wh of warehouses.results) {
    const runStartedAt = new Date();
    try {
      // Each org's orders must sync against *its own* Amazon account, never
      // this deploy's global one — resolveAmazonCredentials only falls back
      // to the global env vars for LEGACY_ORGANIZATION_ID (this deploy's own
      // original warehouse). Real incident (see HANDOFF.md): the first live
      // signup after this code shipped had no Amazon account connected yet,
      // and an earlier version of this fallback silently imported the
      // *original* org's real orders into the new org's warehouse every
      // cron tick. Any other org with no account connected is skipped
      // outright — no import attempt, no silent cross-account sync.
      const credentials = await resolveAmazonCredentials(db, wh.organization_id);
      if (credentials === NOT_CONNECTED) continue;
      const since = wh.amazon_orders_synced_through ? new Date(wh.amazon_orders_synced_through) : new Date(Date.now() - sinceHours * 60 * 60 * 1000);
      const amazonOrders = await fetchUnfulfilledOrders(since, credentials);
      const importSummary = await importAmazonOrders(db, wh.id, amazonOrders, credentials);
      await db.prepare(`UPDATE warehouses SET amazon_orders_synced_through = ? WHERE id = ?`).bind(runStartedAt.toISOString(), wh.id).run();
      const statusResult = await syncOrderStatuses(db, wh.id, credentials);
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
        retrySucceeded: retryResult.succeeded,
        shortOrders: retryResult.shortOrders
      });
    } catch (err) {
      console.error(`Amazon sync job failed for warehouse ${wh.id}:`, err);
    }
  }

  return results;
}
