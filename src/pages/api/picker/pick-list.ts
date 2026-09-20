import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/db';
import { requireUser, AuthError } from '../../../lib/auth';
import { getPickListView, getPickListViewForBatches } from '../../../lib/picker';

// `batchIds` (comma-separated) is the primary form now — admin's Pick Lists
// page groups several batches a picker activated together into one merged
// view (see pick-list.astro / getPickListViewForBatches). `batchId` (single)
// still works unchanged for anything that only ever needs one.
export const GET: APIRoute = async (context) => {
  const db = getDb();
  try {
    await requireUser(context, db, ['packer']);
    const params = new URL(context.request.url).searchParams;
    const batchIdsParam = params.get('batchIds');
    const batchId = params.get('batchId');

    const rows = batchIdsParam
      ? await getPickListViewForBatches(db, batchIdsParam.split(',').filter(Boolean))
      : batchId
        ? await getPickListView(db, batchId)
        : null;
    if (rows === null) return new Response(JSON.stringify({ error: 'batchId or batchIds required' }), { status: 400 });

    return new Response(JSON.stringify(rows), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};
