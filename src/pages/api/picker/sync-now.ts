import type { APIRoute } from 'astro';
import { getDb, logAudit } from '../../../lib/db';
import { requireUser, AuthError } from '../../../lib/auth';
import { runAmazonSyncJob } from '../../../lib/sync-job';

/**
 * Packer-facing twin of api/admin/sync-now.ts — same manual trigger for the
 * pull+status+retry cycle the cron normally runs on a schedule, exposed here
 * too since a packer standing at the floor screen shouldn't have to go find
 * an admin (or wait for the next cron tick) just to get freshly-unblocked
 * orders to show up. Runs across every warehouse like the cron does, not
 * just this packer's own — there's only ever been one warehouse in practice,
 * and scoping it would need a warehouse-filtered variant of the job for no
 * real benefit today.
 */
export const POST: APIRoute = async (context) => {
  const db = getDb();
  try {
    const user = await requireUser(context, db, ['packer']);
    const results = await runAmazonSyncJob(db, 72); // see api/admin/sync-now.ts — a manual click wants a generous catch-up window
    await logAudit(db, { userId: user.id, action: 'sync.manual', metadata: results });
    return new Response(JSON.stringify({ results }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};
