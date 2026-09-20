import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/db';
import { requireUser, AuthError } from '../../../lib/auth';
import { unmergeAllSkus } from '../../../lib/skus';

// Separate route from sku-unmerge.ts (rather than an `{ all: true }` flag on
// it) on purpose — this is a much more consequential action (every merged
// pair at once, no per-pair review) and deserves its own explicit endpoint
// rather than a branch inside the single-SKU one that's easy to trigger by
// accident.
export const POST: APIRoute = async (context) => {
  const db = getDb();
  try {
    const user = await requireUser(context, db, ['admin']);
    const result = await unmergeAllSkus(db, user.id);
    return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};
