import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/db';
import { requireUser, AuthError } from '../../../lib/auth';
import { getMyBatches } from '../../../lib/picker';

// Returns every batch currently active for this picker (auto-claiming one
// via claimNextBatch if they have none), not just a single batch — the
// picker page renders all of them on one continuous scrollable page rather
// than gating on a "get next batch" click. See getMyBatches in lib/picker.ts.
export const POST: APIRoute = async (context) => {
  const db = getDb();
  try {
    const user = await requireUser(context, db, ['packer']);
    const body = await context.request.json<{ warehouseId: string }>();

    const batches = await getMyBatches(db, body.warehouseId, user.id);
    return new Response(JSON.stringify({ batches }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};
