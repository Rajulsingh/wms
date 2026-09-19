import { handle } from '@astrojs/cloudflare/handler';
import { getDb } from './lib/db';
import { runAmazonSyncJob } from './lib/sync-job';

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
    ctx.waitUntil(
      runAmazonSyncJob(getDb()).catch((err) => {
        console.error('Amazon sync job failed:', err);
      })
    );
  }
} satisfies ExportedHandler<Env>;
