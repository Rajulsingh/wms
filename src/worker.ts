import { handle } from '@astrojs/cloudflare/handler';
import { getDb } from './lib/db';
import { runAmazonSyncJob } from './lib/sync-job';
import { cleanupExpiredReturnImages } from './lib/returns';

/**
 * Custom Worker entrypoint (replaces @astrojs/cloudflare's default
 * entrypoints/server, which only exports `fetch`) so a Cloudflare Cron
 * Trigger can drive the Amazon order/status sync automatically — see
 * `[triggers]` in wrangler.jsonc and sync-job.ts. `fetch` is unchanged,
 * just re-exported straight from the adapter's own handler.
 */
export default {
  fetch: handle,
  async scheduled(_controller, _env, ctx) {
    const db = getDb();
    ctx.waitUntil(
      runAmazonSyncJob(db).catch((err) => {
        console.error('Amazon sync job failed:', err);
      })
    );
    // Independent of the Amazon sync above — a failure in one must never
    // block the other. Cheap on every tick (a single indexed-range SELECT
    // that normally finds nothing due yet); see cleanupExpiredReturnImages
    // in lib/returns.ts for why this piggybacks on the existing cron tick
    // instead of its own trigger.
    ctx.waitUntil(
      cleanupExpiredReturnImages(db).catch((err) => {
        console.error('Return image cleanup failed:', err);
      })
    );
  }
} satisfies ExportedHandler<Env>;
