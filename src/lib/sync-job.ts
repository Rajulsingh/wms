import { fetchUnfulfilledOrders } from './amazon';
import { importAmazonOrders, retryBlockedOrders } from './orders';
import { syncOrderStatuses } from './amazon-sync';
import { syncReturnsReport } from './returns';
import { backfillTrackingIds } from './shipping';
import { resolveAmazonCredentials, NOT_CONNECTED } from './org-accounts';
import { logException } from './db';

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
  returnsImported: number;
  returnsStatus: string;
  trackingChecked: number;
  trackingFound: number;
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
      const fetchResult = await fetchUnfulfilledOrders(since, credentials);
      const importSummary = await importAmazonOrders(db, wh.id, fetchResult.orders, credentials);

      // A per-order GetOrderItems failure inside fetchUnfulfilledOrders used
      // to be invisible here — the call still "succeeded" overall, so the
      // watermark advanced to runStartedAt regardless, and that one order's
      // update window could never be re-checked again (see
      // FetchUnfulfilledOrdersResult in amazon.ts). The watermark now only
      // advances as far as the oldest failed order's own LastUpdateDate (a
      // second earlier, so the boundary comparison still includes it) —
      // everything up to that point is safely re-fetched next run too
      // (importAmazonOrders dedupes by external order id, so re-seeing an
      // already-imported order is a no-op, not a duplicate).
      const watermark =
        fetchResult.earliestFailedLastUpdate && fetchResult.earliestFailedLastUpdate < runStartedAt
          ? new Date(fetchResult.earliestFailedLastUpdate.getTime() - 1000)
          : runStartedAt;
      await db.prepare(`UPDATE warehouses SET amazon_orders_synced_through = ? WHERE id = ?`).bind(watermark.toISOString(), wh.id).run();
      for (const failedOrderId of fetchResult.failedOrderIds) {
        await logException(db, {
          type: 'other',
          userId: null,
          notes: `Amazon order ${failedOrderId} failed to fetch during sync (GetOrderItems error) — will retry automatically on the next sync, not lost.`
        });
      }
      const statusResult = await syncOrderStatuses(db, wh.id, credentials);
      const retryResult = await retryBlockedOrders(db, wh.id);

      // One request-or-poll step per tick (see syncReturnsReport) — never
      // lets a returns-report hiccup take down order sync/retry above,
      // same isolation the outer per-warehouse try/catch gives other
      // warehouses.
      let returnsImported = 0;
      let returnsStatus = 'skipped';
      try {
        const returnsResult = await syncReturnsReport(db, wh.id, credentials);
        returnsImported = returnsResult.imported;
        returnsStatus = returnsResult.status;
      } catch (err) {
        console.error(`Returns sync failed for warehouse ${wh.id}:`, err);
        returnsStatus = 'error';
      }

      // Same isolation again — an order still waiting on Amazon to assign
      // its AWB is the normal case, not a failure, so this only ever costs
      // one cron tick's worth of API calls, capped at 15 orders (see
      // backfillTrackingIds in lib/shipping.ts).
      let trackingChecked = 0;
      let trackingFound = 0;
      try {
        const trackingResult = await backfillTrackingIds(db, wh.id, credentials);
        trackingChecked = trackingResult.checked;
        trackingFound = trackingResult.found;
      } catch (err) {
        console.error(`Tracking id backfill failed for warehouse ${wh.id}:`, err);
      }

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
        shortOrders: retryResult.shortOrders,
        returnsImported,
        returnsStatus,
        trackingChecked,
        trackingFound
      });
    } catch (err) {
      console.error(`Amazon sync job failed for warehouse ${wh.id}:`, err);
    }
  }

  return results;
}
