import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/db';
import { requireUser, AuthError } from '../../../lib/auth';
import { confirmGroupQuantity, getBatchIdsForTasks, getPickListView, PickerFlowError } from '../../../lib/picker';

// pickTaskIds can span more than one pick_batch — the picker page groups by
// SKU across every currently-open batch, not one batch at a time — so the
// response returns fresh rows for every batch actually touched instead of
// a single caller-supplied batchId. See getBatchIdsForTasks in lib/picker.ts.
export const POST: APIRoute = async (context) => {
  const db = getDb();
  try {
    const user = await requireUser(context, db, ['packer']);
    const body = await context.request.json<{ pickTaskIds: string[]; quantity: number; reason?: string }>();

    const result = await confirmGroupQuantity(db, user.id, body.pickTaskIds, body.quantity, body.reason);
    const batchIds = await getBatchIdsForTasks(db, body.pickTaskIds);
    const batches = [];
    for (const batchId of batchIds) batches.push({ batchId, rows: await getPickListView(db, batchId) });
    return new Response(JSON.stringify({ result, batches }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    if (err instanceof PickerFlowError) return new Response(JSON.stringify({ error: err.message, code: err.code }), { status: 409 });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};
