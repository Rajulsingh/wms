import type { APIRoute } from 'astro';
import { getDb, logAudit } from '../../../lib/db';
import { requireUser, AuthError } from '../../../lib/auth';
import { runAmazonSyncJob } from '../../../lib/sync-job';

/**
 * Manual trigger for the exact same pull+status+retry cycle the Cloudflare
 * Cron Trigger runs automatically (see worker.ts, sync-job.ts) — added after
 * a real incident: the cron is deliberately scoped to warehouse hours
 * (8:30am-2:30pm IST, see wrangler.jsonc) to stay under the account's cron
 * trigger limit, so anything that changes on Amazon's side outside that
 * window (an order shipped, a late cancellation) just sits unsynced until
 * the window reopens. This button is the escape hatch for exactly that gap
 * — not a replacement for the cron, just a way to force a check right now
 * instead of waiting.
 */
export const POST: APIRoute = async (context) => {
  const db = getDb();
  try {
    const user = await requireUser(context, db, ['admin']);
    const results = await runAmazonSyncJob(db);
    await logAudit(db, { userId: user.id, action: 'sync.manual', metadata: results });
    return new Response(JSON.stringify({ results }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};
