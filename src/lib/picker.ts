import { newId, logAudit, logException } from './db';
import { confirmPick, releaseReservation, unconfirmPick } from './inventory';
import { reserveOrderForPicking } from './orders';
import type { PickTaskView } from './types';

export class PickerFlowError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

/**
 * Resumes this picker's own in-progress batch if they have one (a phone
 * reload or dropped connection shouldn't lose their place — §9: offline/
 * intermittent connectivity), otherwise atomically claims the next
 * unassigned batch (§9: "two pickers must never claim the same task/batch").
 * Every batch is exactly one order's reservation ticket now — created at
 * import/creation time by `reserveOrderForPicking`, not swept together here
 * — so claiming one is claiming one order, and two pickers claiming
 * concurrently always get two different orders. See HANDOFF.md.
 */
export async function claimNextBatch(db: D1Database, warehouseId: string, pickerId: string): Promise<string | null> {
  const resumable = await db
    .prepare(
      `SELECT id FROM pick_batches WHERE warehouse_id = ? AND assigned_picker_id = ? AND status IN ('assigned', 'in_progress') ORDER BY created_at ASC LIMIT 1`
    )
    .bind(warehouseId, pickerId)
    .first<{ id: string }>();
  if (resumable) return resumable.id;

  return claimAvailableBatch(db, warehouseId, pickerId);
}

/**
 * The non-resumable half of claimNextBatch — grabs the next unclaimed
 * (already-reserved) order's batch, regardless of whether this picker
 * already has other work elsewhere. Split out so getMyBatches can call it
 * on every poll, not just when the picker has zero active batches —
 * otherwise orders that land mid-walk sit invisible until everything
 * already open is finished.
 *
 * The "no pending batch" branch is a self-healing safety net, not the
 * normal path: every order should already have a batch from
 * `reserveOrderForPicking` running at import time. It only fires for an
 * order that somehow slipped through unreserved — reserves just that one
 * order on the spot rather than sweeping/creating in bulk (there's nothing
 * left to sweep; reservation already happens per order, immediately). See
 * HANDOFF.md.
 */
async function claimAvailableBatch(db: D1Database, warehouseId: string, pickerId: string): Promise<string | null> {
  let candidate = await db
    .prepare(`SELECT id FROM pick_batches WHERE warehouse_id = ? AND status = 'pending' ORDER BY created_at ASC LIMIT 1`)
    .bind(warehouseId)
    .first<{ id: string }>();

  if (!candidate) {
    const orphan = await db
      .prepare(
        `SELECT o.id FROM orders o
         WHERE o.warehouse_id = ? AND o.status IN ('pending', 'allocated')
           AND NOT EXISTS (SELECT 1 FROM order_items oi JOIN pick_tasks pt ON pt.order_item_id = oi.id WHERE oi.order_id = o.id)
         ORDER BY o.priority DESC, o.created_at ASC LIMIT 1`
      )
      .bind(warehouseId)
      .first<{ id: string }>();
    if (!orphan) return null;

    const result = await reserveOrderForPicking(db, warehouseId, orphan.id);
    if (!result.reserved || !result.batchId) return null;
    candidate = { id: result.batchId };
  }

  const result = await db
    .prepare(`UPDATE pick_batches SET status = 'assigned', assigned_picker_id = ? WHERE id = ? AND status = 'pending'`)
    .bind(pickerId, candidate.id)
    .run();
  // changes === 0 means another picker claimed it between our SELECT and UPDATE — caller should retry.
  return result.meta.changes === 1 ? candidate.id : null;
}

/**
 * The real, persisted record of a human tapping "Activate pick list" (see
 * picker/index.astro) — before this, activation existed only as an
 * in-memory `stage` variable in the browser, so a page reload had no way to
 * tell "already activated, just waiting to start" from "brand new, never
 * looked at" and always fell back to showing the Activate button again.
 * Moving a batch from 'assigned' to 'in_progress' here is what admin's pick
 * list view (see api/admin/batches.ts) now filters on to show only batches
 * a human has actually committed to, not every auto-created reservation
 * ticket. It's also effectively permanent: `assignBatchToPacker` already
 * refuses to touch anything past 'assigned', so nothing in this codebase
 * ever moves a batch back out of 'in_progress'.
 *
 * Scoped to one `shipByDate` — a picker with both a "ship by today" and a
 * "ship by tomorrow" picklist sees two separate gates (picker/index.astro)
 * and activates them independently, so this must only flip the batches for
 * the date actually being activated, never the picker's other pending date.
 */
export async function activateBatches(db: D1Database, warehouseId: string, pickerId: string, shipByDate: string): Promise<void> {
  await db
    .prepare(
      `UPDATE pick_batches SET status = 'in_progress', activated_at = datetime('now')
       WHERE warehouse_id = ? AND assigned_picker_id = ? AND status = 'assigned' AND ship_by_date = ?`
    )
    .bind(warehouseId, pickerId, shipByDate)
    .run();
}

/**
 * Self-healing twin of `activateBatches` for a batch that was swept into an
 * already-activated picker's queue mid-walk (see getMyBatches) — the picker
 * never sees a second gate for it, so nothing else ever calls the explicit
 * activate step for it. Picking (or damage-reporting) any of its tasks is
 * itself unambiguous proof a human is working it, so that's what bumps it
 * here instead. A no-op once already past 'assigned'.
 */
async function markBatchStarted(db: D1Database, pickBatchId: string): Promise<void> {
  await db
    .prepare(`UPDATE pick_batches SET status = 'in_progress', activated_at = datetime('now') WHERE id = ? AND status = 'assigned'`)
    .bind(pickBatchId)
    .run();
}

export interface BatchState {
  batchId: string;
  status: string;
  nextLocation: { id: string; code: string; qrToken: string } | null;
  tasksAtLocation: PickTaskView[];
  remainingLocations: number;
  complete: boolean;
}

/** The picker's whole screen state: the next location to visit and what to pick there. Everything else about the batch is deliberately not exposed — one location at a time (§8). */
export async function getBatchState(db: D1Database, batchId: string): Promise<BatchState> {
  const batch = await db.prepare(`SELECT status FROM pick_batches WHERE id = ?`).bind(batchId).first<{ status: string }>();
  if (!batch) throw new PickerFlowError('not_found', 'Batch not found');

  const pending = await db
    .prepare(
      `SELECT DISTINCT loc.id, loc.code, loc.qr_token, loc.sequence_number
       FROM pick_tasks pt JOIN locations loc ON loc.id = pt.location_id
       WHERE pt.pick_batch_id = ? AND pt.status IN ('pending', 'location_confirmed')
       ORDER BY loc.sequence_number ASC`
    )
    .bind(batchId)
    .all<{ id: string; code: string; qr_token: string; sequence_number: number }>();

  if (!pending.results.length) {
    return { batchId, status: batch.status, nextLocation: null, tasksAtLocation: [], remainingLocations: 0, complete: true };
  }

  const next = pending.results[0];
  const remainingLocationIds = new Set(pending.results.map((l) => l.id));

  const tasks = await db
    .prepare(
      `SELECT pt.*, sk.sku_code, sk.name AS sku_name, sk.barcode, sk.image_url, loc.code AS location_code, loc.qr_token AS location_qr_token
       FROM pick_tasks pt
       JOIN skus sk ON sk.id = pt.sku_id
       JOIN locations loc ON loc.id = pt.location_id
       WHERE pt.pick_batch_id = ? AND pt.location_id = ? AND pt.status IN ('pending', 'location_confirmed')`
    )
    .bind(batchId, next.id)
    .all<PickTaskView>();

  return {
    batchId,
    status: batch.status,
    nextLocation: { id: next.id, code: next.code, qrToken: next.qr_token },
    tasksAtLocation: tasks.results,
    remainingLocations: remainingLocationIds.size,
    complete: false
  };
}

export interface PickListRow {
  pick_task_id: string;
  zone_name: string | null;
  location_code: string;
  sequence_number: number;
  sku_code: string;
  sku_name: string;
  image_url: string | null;
  external_order_id: string;
  order_source: string;
  order_notes: string | null;
  quantity_required: number;
  quantity_picked: number;
  status: string;
}

/**
 * The whole batch as one flat, zone/bin-sorted list across every order in
 * it — not one location at a time. Matches how real fulfillment tools
 * (e.g. Amazon's own Seller Flex pick list) present this: a picker scans
 * nothing, just works down the list checking off lines, because requiring a
 * scan per physical unit doesn't hold up at real volume ("can't barcode
 * every single product unit"). The underlying reservation/exception
 * machinery (confirmQuantity, reportDamaged) is unchanged — only the
 * location-by-location gating and mandatory scan steps are gone.
 *
 * Excludes cancelled orders regardless of the pick_task's own status — a
 * real bug found live: cancelOrderFromSync (amazon-sync.ts) only cleans up
 * tasks still 'pending'/'location_confirmed' when Amazon cancels an order,
 * so one already resolved as 'short' (a picker genuinely found insufficient
 * stock, then Amazon cancelled it afterward) was never touched and kept
 * showing as a permanently "unresolved" short pick with no way to clear it,
 * for an order nothing can or should be done for any more. Filtering here
 * covers every pre-cancellation task status at once rather than needing
 * cancelOrderFromSync to handle each one individually.
 */
export async function getPickListView(db: D1Database, batchId: string): Promise<PickListRow[]> {
  const rows = await db
    .prepare(
      `SELECT
         pt.id AS pick_task_id,
         z.name AS zone_name,
         loc.code AS location_code,
         loc.sequence_number,
         sk.sku_code,
         sk.name AS sku_name,
         sk.image_url,
         o.external_order_id,
         o.source AS order_source,
         o.notes AS order_notes,
         pt.quantity_required,
         pt.quantity_picked,
         pt.status
       FROM pick_tasks pt
       JOIN locations loc ON loc.id = pt.location_id
       LEFT JOIN zones z ON z.id = loc.zone_id
       JOIN skus sk ON sk.id = pt.sku_id
       JOIN order_items oi ON oi.id = pt.order_item_id
       JOIN orders o ON o.id = oi.order_id
       WHERE pt.pick_batch_id = ? AND o.status != 'cancelled'
       ORDER BY loc.sequence_number ASC, sk.sku_code ASC`
    )
    .bind(batchId)
    .all<PickListRow>();
  return rows.results;
}

/**
 * Bulk version of `getPickListView` for admin's Pick Lists page (pick-
 * list.astro), which now groups every batch a picker activated together
 * (same `activated_at`, see activateBatches) into one printable/downloadable
 * list instead of showing one order per row — one query for the whole group
 * rather than looping getPickListView per batch.
 */
export async function getPickListViewForBatches(db: D1Database, batchIds: string[]): Promise<PickListRow[]> {
  if (!batchIds.length) return [];
  const placeholders = batchIds.map(() => '?').join(',');
  const rows = await db
    .prepare(
      `SELECT
         pt.id AS pick_task_id,
         z.name AS zone_name,
         loc.code AS location_code,
         loc.sequence_number,
         sk.sku_code,
         sk.name AS sku_name,
         sk.image_url,
         o.external_order_id,
         o.source AS order_source,
         o.notes AS order_notes,
         pt.quantity_required,
         pt.quantity_picked,
         pt.status
       FROM pick_tasks pt
       JOIN locations loc ON loc.id = pt.location_id
       LEFT JOIN zones z ON z.id = loc.zone_id
       JOIN skus sk ON sk.id = pt.sku_id
       JOIN order_items oi ON oi.id = pt.order_item_id
       JOIN orders o ON o.id = oi.order_id
       WHERE pt.pick_batch_id IN (${placeholders}) AND o.status != 'cancelled'
       ORDER BY loc.sequence_number ASC, sk.sku_code ASC`
    )
    .bind(...batchIds)
    .all<PickListRow>();
  return rows.results;
}

/** NFC-equivalent step: verify the picker is physically at the expected location via its QR/barcode token (§4 — barcode/QR, not NFC, given the mixed iOS/Android fleet). */
export async function confirmLocation(db: D1Database, userId: string, batchId: string, scannedQrToken: string): Promise<void> {
  const state = await getBatchState(db, batchId);
  if (!state.nextLocation) throw new PickerFlowError('batch_complete', 'This batch has no remaining locations');

  if (state.nextLocation.qrToken !== scannedQrToken) {
    await logException(db, { type: 'wrong_location', orderId: undefined, userId, notes: `Expected ${state.nextLocation.code}, scanned token for a different location` });
    throw new PickerFlowError('wrong_location', `Wrong rack. Go to ${state.nextLocation.code}.`);
  }

  await db
    .prepare(`UPDATE pick_tasks SET status = 'location_confirmed' WHERE pick_batch_id = ? AND location_id = ? AND status = 'pending'`)
    .bind(batchId, state.nextLocation.id)
    .run();
  await db.prepare(`UPDATE pick_batches SET status = 'in_progress' WHERE id = ? AND status = 'assigned'`).bind(batchId).run();
  await logAudit(db, { userId, action: 'scan.location', entityType: 'location', entityId: state.nextLocation.id });
}

/** Verifies a scanned item barcode matches the expected SKU for this task, without yet confirming quantity (§4/§6). */
export async function verifyItemScan(db: D1Database, userId: string, pickTaskId: string, scannedBarcode: string): Promise<void> {
  const task = await db
    .prepare(
      `SELECT pt.id, pt.status, sk.barcode, sk.sku_code FROM pick_tasks pt JOIN skus sk ON sk.id = pt.sku_id WHERE pt.id = ?`
    )
    .bind(pickTaskId)
    .first<{ id: string; status: string; barcode: string | null; sku_code: string }>();
  if (!task) throw new PickerFlowError('not_found', 'Pick task not found');
  if (task.status !== 'location_confirmed') {
    throw new PickerFlowError('wrong_state', 'Confirm you are at the correct rack before scanning items');
  }

  const matches = task.barcode ? task.barcode === scannedBarcode : task.sku_code === scannedBarcode;
  if (!matches) {
    await logException(db, { type: 'wrong_sku_scan', pickTaskId, userId, notes: `Scanned "${scannedBarcode}", expected SKU ${task.sku_code}` });
    throw new PickerFlowError('wrong_sku', 'Wrong item — that barcode does not match what is needed here.');
  }
  await logAudit(db, { userId, action: 'scan.item', entityType: 'pick_task', entityId: pickTaskId });
}

export interface ConfirmQuantityResult {
  status: 'picked' | 'short';
  batchComplete: boolean;
}

/** Consumes the reservation for whatever quantity was actually picked. A short pick doesn't fail the call — it's a legitimate outcome logged as an exception (§6), never a dead end for the picker. `reason`, when given, is the picker's chosen explanation for the shortfall (e.g. "Low stock — not enough available") and is appended to the exception note so admin sees why, not just the numbers. */
export async function confirmQuantity(db: D1Database, userId: string, pickTaskId: string, quantity: number, reason?: string): Promise<ConfirmQuantityResult> {
  const task = await db
    .prepare(`SELECT pt.*, sk.id as sku_id_check FROM pick_tasks pt JOIN skus sk ON sk.id = pt.sku_id WHERE pt.id = ?`)
    .bind(pickTaskId)
    .first<{ id: string; pick_batch_id: string; order_item_id: string; sku_id: string; location_id: string; quantity_required: number; quantity_picked: number }>();
  if (!task) throw new PickerFlowError('not_found', 'Pick task not found');
  // `quantity` is what's being picked *now*, added on top of whatever this
  // task already carries — normally 0 (a task is only ever confirmed once),
  // but can be nonzero if unpickGroupQuantity reopened it after a partial
  // undo. Validating/allocating against the remaining gap rather than the
  // full quantity_required is what makes re-picking after a partial unpick
  // land on the right total instead of silently losing the earlier progress.
  const remainingRequired = task.quantity_required - task.quantity_picked;
  if (quantity > remainingRequired) {
    throw new PickerFlowError('over_pick', `Cannot pick more than the required ${remainingRequired} without a supervisor override`);
  }

  const inventory = await db
    .prepare(`SELECT id FROM inventory WHERE sku_id = ? AND location_id = ?`)
    .bind(task.sku_id, task.location_id)
    .first<{ id: string }>();
  if (!inventory) throw new PickerFlowError('inventory_missing', 'No inventory row for this SKU/location — data integrity issue');

  await markBatchStarted(db, task.pick_batch_id);

  if (quantity > 0) await confirmPick(db, inventory.id, quantity);
  const newQuantityPicked = task.quantity_picked + quantity;
  const shortfall = task.quantity_required - newQuantityPicked;
  if (shortfall > 0) await releaseReservation(db, inventory.id, shortfall);

  const status = shortfall > 0 ? 'short' : 'picked';
  await db
    .prepare(`UPDATE pick_tasks SET status = ?, quantity_picked = ?, picked_at = datetime('now') WHERE id = ?`)
    .bind(status, newQuantityPicked, pickTaskId)
    .run();
  await db
    .prepare(`UPDATE order_items SET quantity_picked = quantity_picked + ?, status = ? WHERE id = ?`)
    .bind(quantity, status === 'short' ? 'short' : 'picked', task.order_item_id)
    .run();

  if (shortfall > 0) {
    const orderItem = await db.prepare(`SELECT order_id FROM order_items WHERE id = ?`).bind(task.order_item_id).first<{ order_id: string }>();
    await logException(db, {
      type: 'short_pick',
      pickTaskId,
      orderId: orderItem?.order_id,
      userId,
      notes: reason ? `Required ${task.quantity_required}, picked ${quantity} — ${reason}` : `Required ${task.quantity_required}, picked ${quantity}`
    });
  }
  await logAudit(db, { userId, action: 'confirm.quantity', entityType: 'pick_task', entityId: pickTaskId, metadata: { quantity, status } });

  const batchComplete = await checkBatchCompletion(db, task.pick_batch_id);

  return { status, batchComplete };
}

/**
 * Marks the batch completed (and its orders 'picked') the moment every one
 * of its pick_tasks has left 'pending'/'location_confirmed' — regardless of
 * *how* the last one resolved. Shared by confirmQuantity and reportDamaged:
 * originally only confirmQuantity did this check, so a batch whose very
 * last outstanding line resolved via "damaged" instead of a normal pick
 * would never flip to 'completed' and its order would never reach
 * 'picked' — silently stuck, never appearing in the packing queue. Found
 * while testing the bulk group-pick flow; damage-report becoming a much
 * more directly reachable action (not buried in a sub-sheet) made this
 * easy to hit, but the bug itself predates that change.
 */
async function checkBatchCompletion(db: D1Database, pickBatchId: string): Promise<boolean> {
  const remaining = await db
    .prepare(`SELECT COUNT(*) as c FROM pick_tasks WHERE pick_batch_id = ? AND status IN ('pending', 'location_confirmed')`)
    .bind(pickBatchId)
    .first<{ c: number }>();
  const batchComplete = (remaining?.c ?? 0) === 0;
  if (batchComplete) {
    await db.prepare(`UPDATE pick_batches SET status = 'completed', completed_at = datetime('now') WHERE id = ?`).bind(pickBatchId).run();
    await db
      .prepare(
        `UPDATE orders SET status = 'picked'
         WHERE id IN (SELECT DISTINCT o.id FROM orders o JOIN order_items oi ON oi.order_id = o.id JOIN pick_tasks pt ON pt.order_item_id = oi.id WHERE pt.pick_batch_id = ?)
         AND status = 'batched'`
      )
      .bind(pickBatchId)
      .run();
  }
  return batchComplete;
}

/**
 * Which pick_batches a set of pick_task ids actually belong to — a bulk
 * pick/damage submission can span more than one batch now that the picker
 * page groups by SKU across every currently-open batch instead of rendering
 * one batch at a time (see picker/index.astro). Callers use this to know
 * which batches' rows need refreshing in the response, without guessing or
 * requiring the client to already know which batch(es) it touched.
 */
export async function getBatchIdsForTasks(db: D1Database, pickTaskIds: string[]): Promise<string[]> {
  if (!pickTaskIds.length) return [];
  const placeholders = pickTaskIds.map(() => '?').join(',');
  const rows = await db
    .prepare(`SELECT DISTINCT pick_batch_id FROM pick_tasks WHERE id IN (${placeholders})`)
    .bind(...pickTaskIds)
    .all<{ pick_batch_id: string }>();
  return rows.results.map((r) => r.pick_batch_id);
}

export interface ConfirmGroupResult {
  perTask: Array<{ pickTaskId: string; quantity: number; status: 'picked' | 'short' }>;
  batchComplete: boolean;
}

/**
 * Bulk pick confirm — one SKU at one location, however many order_items
 * happen to need it. The picker sees one aggregate line ("KTN3 required 7,
 * picked 0/7") instead of one card per order, picks the physical quantity
 * once, and confirms once. Underneath, nothing about per-order reservation/
 * exception tracking changes: `totalQuantity` is allocated across the given
 * tasks in order (highest priority, then oldest order first — same
 * convention as batch creation) and each task is settled through the exact
 * same confirmQuantity() a single-task pick already used, so a task that
 * doesn't get its full share is logged as a normal short pick, not a new
 * concept. This is what makes "pick 5 of the 7 available" fall out for
 * free instead of needing separate bulk-short-pick logic.
 */
export async function confirmGroupQuantity(db: D1Database, userId: string, pickTaskIds: string[], totalQuantity: number, reason?: string): Promise<ConfirmGroupResult> {
  if (!pickTaskIds.length) throw new PickerFlowError('not_found', 'No pick tasks given');

  const placeholders = pickTaskIds.map(() => '?').join(',');
  const tasks = await db
    .prepare(
      `SELECT pt.id, pt.quantity_required, pt.quantity_picked
       FROM pick_tasks pt
       JOIN order_items oi ON oi.id = pt.order_item_id
       JOIN orders o ON o.id = oi.order_id
       WHERE pt.id IN (${placeholders})
       ORDER BY o.priority DESC, o.created_at ASC`
    )
    .bind(...pickTaskIds)
    .all<{ id: string; quantity_required: number; quantity_picked: number }>();

  // Remaining per task, not the full quantity_required — a task can already
  // carry a partial quantity_picked here (see confirmQuantity), same reason.
  const totalRemaining = tasks.results.reduce((sum, t) => sum + (t.quantity_required - t.quantity_picked), 0);
  if (totalQuantity > totalRemaining) {
    throw new PickerFlowError('over_pick', `Cannot pick more than the required ${totalRemaining} without a supervisor override`);
  }

  let remaining = totalQuantity;
  const perTask: ConfirmGroupResult['perTask'] = [];
  let batchComplete = false;

  for (const task of tasks.results) {
    const taskRemaining = task.quantity_required - task.quantity_picked;
    const allocated = Math.min(remaining, taskRemaining);
    remaining -= allocated;
    const result = await confirmQuantity(db, userId, task.id, allocated, reason);
    perTask.push({ pickTaskId: task.id, quantity: allocated, status: result.status });
    if (result.batchComplete) batchComplete = true;
  }

  return { perTask, batchComplete };
}

export interface UnpickResult {
  perTask: Array<{ pickTaskId: string; newQuantityPicked: number }>;
  undone: number;
}

/**
 * Reverses a mistaken "Picked" confirmation — a fat-fingered quantity or a
 * card tapped by accident. Puts the undone units back on the shelf
 * (inventory) and the task(s) they came from back into the active pick
 * list, allocating `totalQuantity` across the given tasks in the same
 * priority order confirmGroupQuantity used to pick them, so "unpick 3 of 6"
 * pulls back starting with the earliest/highest-priority order first —
 * same convention, just run in reverse.
 *
 * Only ever touches tasks currently 'picked' (a clean full pick, no
 * exception on file) — a 'short'/'damaged' task already has its own
 * exception trail and reversing it would mean unwinding that too, which
 * this deliberately doesn't attempt; a mis-recorded short/damaged pick
 * needs an admin correction (see api/admin/inventory.ts), not a floor
 * undo button.
 *
 * A task that keeps a nonzero quantity_picked after a partial undo goes
 * back to 'pending' anyway (not some new "partially pending" status) —
 * the picker UI's remainingNeeded calc already accounts for quantity_picked
 * on a pending row (required - already-picked), so this doesn't need a new
 * status to stay correct. Also reopens a batch/order that had already
 * auto-completed off the back of the task(s) just reversed, but only while
 * it's still exactly where confirmGroupQuantity left it — same
 * only-touch-what's-still-expected caution lib/reset.ts uses, so an order
 * that's already moved on to packing is never silently pulled back.
 */
export async function unpickGroupQuantity(db: D1Database, userId: string, pickTaskIds: string[], totalQuantity: number): Promise<UnpickResult> {
  if (!pickTaskIds.length) throw new PickerFlowError('not_found', 'No pick tasks given');

  const placeholders = pickTaskIds.map(() => '?').join(',');
  const tasks = await db
    .prepare(
      `SELECT pt.id, pt.pick_batch_id, pt.order_item_id, pt.sku_id, pt.location_id, pt.quantity_picked
       FROM pick_tasks pt
       JOIN order_items oi ON oi.id = pt.order_item_id
       JOIN orders o ON o.id = oi.order_id
       WHERE pt.id IN (${placeholders}) AND pt.status = 'picked'
       ORDER BY o.priority DESC, o.created_at ASC`
    )
    .bind(...pickTaskIds)
    .all<{ id: string; pick_batch_id: string; order_item_id: string; sku_id: string; location_id: string; quantity_picked: number }>();

  const totalPicked = tasks.results.reduce((sum, t) => sum + t.quantity_picked, 0);
  if (totalQuantity <= 0) throw new PickerFlowError('invalid_quantity', 'Unpick quantity must be greater than zero');
  if (totalQuantity > totalPicked) throw new PickerFlowError('over_unpick', `Cannot unpick more than the ${totalPicked} currently picked`);

  let remaining = totalQuantity;
  const perTask: UnpickResult['perTask'] = [];
  const touchedBatches = new Set<string>();

  for (const task of tasks.results) {
    if (remaining <= 0) break;
    const undoQty = Math.min(remaining, task.quantity_picked);
    if (undoQty <= 0) continue;
    remaining -= undoQty;

    const inventory = await db.prepare(`SELECT id FROM inventory WHERE sku_id = ? AND location_id = ?`).bind(task.sku_id, task.location_id).first<{ id: string }>();
    if (!inventory) throw new PickerFlowError('inventory_missing', 'No inventory row for this SKU/location — data integrity issue');
    await unconfirmPick(db, inventory.id, undoQty);

    const newQuantityPicked = task.quantity_picked - undoQty;
    await db.prepare(`UPDATE pick_tasks SET status = 'pending', quantity_picked = ?, picked_at = NULL WHERE id = ?`).bind(newQuantityPicked, task.id).run();
    await db.prepare(`UPDATE order_items SET quantity_picked = quantity_picked - ?, status = 'pending' WHERE id = ?`).bind(undoQty, task.order_item_id).run();
    await logAudit(db, { userId, action: 'unpick.quantity', entityType: 'pick_task', entityId: task.id, metadata: { undoQty, newQuantityPicked } });

    touchedBatches.add(task.pick_batch_id);
    perTask.push({ pickTaskId: task.id, newQuantityPicked });
  }

  for (const batchId of touchedBatches) {
    await db.prepare(`UPDATE pick_batches SET status = 'in_progress', completed_at = NULL WHERE id = ? AND status = 'completed'`).bind(batchId).run();
    await db
      .prepare(
        `UPDATE orders SET status = 'batched'
         WHERE status = 'picked' AND id IN (SELECT DISTINCT o.id FROM orders o JOIN order_items oi ON oi.order_id = o.id JOIN pick_tasks pt ON pt.order_item_id = oi.id WHERE pt.pick_batch_id = ?)`
      )
      .bind(batchId)
      .run();
  }

  return { perTask, undone: totalQuantity - remaining };
}

/** Group version of reportDamaged — every task in the group is damaged, none usable. Matches the picker UI's single "Damaged — none usable" action applied to the whole aggregate line, not a partial-damage concept that doesn't exist for a single task either. */
export async function reportGroupDamaged(db: D1Database, userId: string, pickTaskIds: string[], notes?: string): Promise<void> {
  for (const pickTaskId of pickTaskIds) {
    await reportDamaged(db, userId, pickTaskId, notes);
  }
}

/**
 * Damaged-item report (§6): pulls exactly the damaged quantity out of
 * sellable inventory and releases its reservation, without blocking the
 * rest of the order — or the rest of that bin's stock.
 *
 * Used to blanket-flag the whole (sku, location) row `status = 'damaged'`
 * instead of removing only the reported quantity — a real incident: a
 * picker reporting 1 unit damaged out of a 50-unit bin marked the entire 50
 * units unreservable, and stayed that way for every future order needing
 * that SKU until someone happened to notice (see HANDOFF.md, the COFFEE2
 * incident). `confirmPick` already does exactly the right bookkeeping for
 * "these N units are no longer real stock" — it CAS-decrements both
 * `quantity_on_hand` and `quantity_reserved` together, which is the correct
 * inventory effect whether those units left the building on a truck or in
 * the trash. Reusing it here means damaged units are removed precisely,
 * and everything else in the bin stays exactly as reservable as it was.
 */
export async function reportDamaged(db: D1Database, userId: string, pickTaskId: string, notes?: string): Promise<void> {
  const task = await db
    .prepare(`SELECT id, pick_batch_id, order_item_id, sku_id, location_id, quantity_required FROM pick_tasks WHERE id = ?`)
    .bind(pickTaskId)
    .first<{ id: string; pick_batch_id: string; order_item_id: string; sku_id: string; location_id: string; quantity_required: number }>();
  if (!task) throw new PickerFlowError('not_found', 'Pick task not found');

  await markBatchStarted(db, task.pick_batch_id);

  const inventory = await db
    .prepare(`SELECT id FROM inventory WHERE sku_id = ? AND location_id = ?`)
    .bind(task.sku_id, task.location_id)
    .first<{ id: string }>();
  if (inventory) {
    await confirmPick(db, inventory.id, task.quantity_required);
  }

  await db.prepare(`UPDATE pick_tasks SET status = 'damaged' WHERE id = ?`).bind(pickTaskId).run();
  await db.prepare(`UPDATE order_items SET status = 'short' WHERE id = ?`).bind(task.order_item_id).run();

  const orderItem = await db.prepare(`SELECT order_id FROM order_items WHERE id = ?`).bind(task.order_item_id).first<{ order_id: string }>();
  await logException(db, { type: 'damaged', pickTaskId, orderId: orderItem?.order_id, userId, notes });
  await logAudit(db, { userId, action: 'report.damaged', entityType: 'pick_task', entityId: pickTaskId });

  await checkBatchCompletion(db, task.pick_batch_id);
}

/**
 * Every batch currently active for this picker (assigned or in progress),
 * oldest first — not just the single "resumable" one `claimNextBatch`
 * returns. Under the normal claim flow a picker only ever has one active
 * batch at a time (claimNextBatch won't sweep a second one for them while
 * they still have one), but admin's manual per-packer assignment (see
 * `assignBatchToPacker`) can hand someone a second batch directly, so the
 * picker's "all my batches on one page" view needs to show every one, not
 * assume there's at most one.
 */
export async function getMyActiveBatches(db: D1Database, warehouseId: string, pickerId: string): Promise<string[]> {
  const rows = await db
    .prepare(
      `SELECT id FROM pick_batches WHERE warehouse_id = ? AND assigned_picker_id = ? AND status IN ('assigned', 'in_progress') ORDER BY created_at ASC`
    )
    .bind(warehouseId, pickerId)
    .all<{ id: string }>();
  return rows.results.map((r) => r.id);
}

export interface MyBatchEntry {
  batchId: string;
  status: string;
  shipByDate: string | null;
  rows: PickListRow[];
}

/**
 * Returns this picker's active batches (rows for each), auto-claiming/
 * creating one via `claimNextBatch` only when they currently have none —
 * mirrors the original claim-time behavior for a picker with no work, while
 * never taking a second batch away from the pending pool for someone who
 * already has one (admin assignment is the only way to get a second).
 *
 * Fetches every batch's rows in one query instead of looping `getPickListView`
 * per batch — the picker page now gates on an explicit "Activate pick list"
 * step (see picker/index.astro) that has to feel instant, and a packer with
 * a dozen small orders waiting was previously a dozen sequential D1 round
 * trips just to render the button. `status` is included per batch so the UI
 * can tell a genuinely fresh claim (still 'assigned') from a reload mid-walk
 * (already 'in_progress') and skip the activation gate for the latter —
 * resuming shouldn't require re-confirming work already underway.
 */
export async function getMyBatches(db: D1Database, warehouseId: string, pickerId: string): Promise<MyBatchEntry[]> {
  const batchIds = await getMyActiveBatches(db, warehouseId, pickerId);
  // Sweep in everything currently available, not just one — not gated on
  // "only when I have none" either, so this doubles as the continuous-flow
  // poll: orders that land mid-walk (or were just sitting open when the
  // picker first opened the page) get swept into fresh batches and appended
  // to the picker's page all at once, instead of trickling in one cart-load
  // per 8s poll tick. Mirrors packing's getMyPackBatches, which already
  // loops the same way. claimAvailableBatch is naturally bounded — it stops
  // once there's nothing left open to batch. See HANDOFF.md.
  for (;;) {
    const claimed = await claimAvailableBatch(db, warehouseId, pickerId);
    if (!claimed) break;
    batchIds.push(claimed);
  }

  // Also surface batches this picker finished earlier today — a completed
  // pick_batch drops out of getMyActiveBatches by design (packing takes over
  // from here, it's no longer "active" picking work), but that meant a
  // reload right after finishing every order for a date showed nothing at
  // all where that date's card used to be — a real gap found live. Bounded
  // to "completed today" (UTC calendar day, a loose bound — picker/index.astro
  // does the real IST today/tomorrow filtering client-side) so this can't
  // grow into a full history scan.
  const recentlyCompleted = await db
    .prepare(`SELECT id FROM pick_batches WHERE warehouse_id = ? AND assigned_picker_id = ? AND status = 'completed' AND completed_at >= date('now')`)
    .bind(warehouseId, pickerId)
    .all<{ id: string }>();
  for (const r of recentlyCompleted.results) if (!batchIds.includes(r.id)) batchIds.push(r.id);

  if (!batchIds.length) return [];

  const placeholders = batchIds.map(() => '?').join(',');
  const [statusRows, allRows] = await Promise.all([
    db
      .prepare(`SELECT id, status, ship_by_date FROM pick_batches WHERE id IN (${placeholders})`)
      .bind(...batchIds)
      .all<{ id: string; status: string; ship_by_date: string | null }>(),
    db
      .prepare(
        `SELECT
           pt.pick_batch_id AS pick_batch_id,
           pt.id AS pick_task_id,
           z.name AS zone_name,
           loc.code AS location_code,
           loc.sequence_number,
           sk.sku_code,
           sk.name AS sku_name,
           sk.image_url,
           o.external_order_id,
           o.source AS order_source,
           o.notes AS order_notes,
           pt.quantity_required,
           pt.quantity_picked,
           pt.status
         FROM pick_tasks pt
         JOIN locations loc ON loc.id = pt.location_id
         LEFT JOIN zones z ON z.id = loc.zone_id
         JOIN skus sk ON sk.id = pt.sku_id
         JOIN order_items oi ON oi.id = pt.order_item_id
         JOIN orders o ON o.id = oi.order_id
         WHERE pt.pick_batch_id IN (${placeholders}) AND o.status != 'cancelled'
         ORDER BY loc.sequence_number ASC, sk.sku_code ASC`
      )
      .bind(...batchIds)
      .all<PickListRow & { pick_batch_id: string }>()
  ]);

  const statusByBatch = new Map(statusRows.results.map((r) => [r.id, r.status]));
  const shipByDateByBatch = new Map(statusRows.results.map((r) => [r.id, r.ship_by_date]));
  const rowsByBatch = new Map<string, PickListRow[]>();
  for (const r of allRows.results) {
    const list = rowsByBatch.get(r.pick_batch_id) ?? [];
    list.push(r);
    rowsByBatch.set(r.pick_batch_id, list);
  }

  return batchIds.map((batchId) => ({
    batchId,
    shipByDate: shipByDateByBatch.get(batchId) ?? null,
    status: statusByBatch.get(batchId) ?? 'pending',
    rows: rowsByBatch.get(batchId) ?? []
  }));
}

export interface SkuDemandRow {
  skuId: string;
  skuCode: string;
  skuName: string;
  imageUrl: string | null;
  orderCount: number;
  unitsNeeded: number;
}

/**
 * Everything currently unclaimed (pick_batches still 'pending'), grouped by
 * SKU rather than one row per order — replaces the old per-batch "upcoming"
 * list, which showed nothing but a timestamp per order (since one batch is
 * always exactly one order, "order count" on it was always 1) and didn't
 * scale past a handful of rows. This is the single source of truth for
 * "what's waiting to be worked on": both the packer dashboard's read-only
 * preview and the admin's bulk-assign-by-SKU screen call this same function,
 * on purpose, so the two views can never show different numbers for the
 * same underlying pile of work.
 */
export async function getUnassignedSkuDemand(db: D1Database, warehouseId: string): Promise<SkuDemandRow[]> {
  const rows = await db
    .prepare(
      `SELECT sk.id AS sku_id, sk.sku_code, sk.name AS sku_name, sk.image_url,
              COUNT(DISTINCT pt.pick_batch_id) AS order_count,
              SUM(pt.quantity_required) AS units_needed
       FROM pick_tasks pt
       JOIN pick_batches pb ON pb.id = pt.pick_batch_id
       JOIN skus sk ON sk.id = pt.sku_id
       WHERE pb.warehouse_id = ? AND pb.status = 'pending' AND pt.status = 'pending'
       GROUP BY sk.id
       ORDER BY sk.sku_code ASC`
    )
    .bind(warehouseId)
    .all<{ sku_id: string; sku_code: string; sku_name: string; image_url: string | null; order_count: number; units_needed: number }>();

  return rows.results.map((r) => ({
    skuId: r.sku_id,
    skuCode: r.sku_code,
    skuName: r.sku_name,
    imageUrl: r.image_url,
    orderCount: r.order_count,
    unitsNeeded: r.units_needed
  }));
}

export interface AssignSkusResult {
  batchesAssigned: number;
  ordersWithOtherSkus: number;
  failed: number;
}

/**
 * Bulk-assigns every currently-unclaimed order that needs at least one of
 * the given SKUs to one packer — the "assign this SKU (or these SKUs) to a
 * packer" action, without splitting a single order's own pick_tasks across
 * different packers (that would mean rewriting claimNextBatch/
 * checkBatchCompletion around per-task rather than per-batch ownership, a
 * much bigger and riskier change than the actual ask: making bulk
 * assignment fast and SKU-legible). The whole order (batch) still moves
 * together — `ordersWithOtherSkus` tells the caller how many of the
 * assigned orders also needed a SKU outside the selected set, so the UI can
 * say so rather than the admin discovering it later on the picker's own
 * screen. Reuses assignBatchToPacker as-is; one batch losing a race (already
 * claimed between the SELECT and the assign) doesn't abort the rest.
 */
export async function assignSkusToPacker(db: D1Database, warehouseId: string, skuIds: string[], packerId: string): Promise<AssignSkusResult> {
  if (!skuIds.length) throw new PickerFlowError('no_skus', 'Select at least one SKU');
  const skuPh = skuIds.map(() => '?').join(',');

  const batches = await db
    .prepare(
      `SELECT DISTINCT pb.id
       FROM pick_batches pb JOIN pick_tasks pt ON pt.pick_batch_id = pb.id
       WHERE pb.warehouse_id = ? AND pb.status = 'pending' AND pt.status = 'pending' AND pt.sku_id IN (${skuPh})`
    )
    .bind(warehouseId, ...skuIds)
    .all<{ id: string }>();

  let ordersWithOtherSkus = 0;
  let failed = 0;
  for (const b of batches.results) {
    const otherSku = await db
      .prepare(`SELECT COUNT(*) as c FROM pick_tasks WHERE pick_batch_id = ? AND status = 'pending' AND sku_id NOT IN (${skuPh})`)
      .bind(b.id, ...skuIds)
      .first<{ c: number }>();
    if (otherSku && otherSku.c > 0) ordersWithOtherSkus++;

    try {
      await assignBatchToPacker(db, warehouseId, b.id, packerId);
    } catch {
      failed++;
    }
  }

  return { batchesAssigned: batches.results.length - failed, ordersWithOtherSkus, failed };
}

/**
 * Admin hand-assigns a specific pending/already-assigned batch to a named
 * packer — sets `assigned_picker_id` directly rather than waiting for that
 * packer to claim it themselves. This is safe against the general claim
 * pool: the moment status leaves 'pending', `claimNextBatch`'s sweep query
 * (`WHERE status = 'pending'`) no longer sees it, so no other picker can
 * grab it out from under the one admin picked. The named packer then picks
 * it up automatically next time they load/poll — it's exactly what
 * `getMyActiveBatches` looks for (assigned_picker_id = them, status
 * 'assigned'/'in_progress').
 *
 * `packerId: null` clears the assignment instead — puts the batch back to
 * `'pending'` so it returns to the general claim pool (any picker who next
 * asks for work, or another admin assignment, can pick it up). Only allowed
 * while nobody has actually started on it yet (same 'pending'/'assigned'
 * gate as assigning); once a picker has begun ('in_progress'), unassigning
 * would orphan their in-progress reservations/pick_tasks, so that's blocked
 * the same way reassigning already is.
 */
export async function assignBatchToPacker(db: D1Database, warehouseId: string, batchId: string, packerId: string | null): Promise<void> {
  const batch = await db
    .prepare(`SELECT status FROM pick_batches WHERE id = ? AND warehouse_id = ?`)
    .bind(batchId, warehouseId)
    .first<{ status: string }>();
  if (!batch) throw new PickerFlowError('not_found', 'Batch not found');
  if (batch.status !== 'pending' && batch.status !== 'assigned') {
    throw new PickerFlowError('wrong_state', `This batch is already ${batch.status} — it can no longer be (re)assigned.`);
  }

  if (packerId === null) {
    await db.prepare(`UPDATE pick_batches SET status = 'pending', assigned_picker_id = NULL WHERE id = ?`).bind(batchId).run();
    return;
  }

  const packer = await db
    .prepare(`SELECT id FROM users WHERE id = ? AND warehouse_id = ? AND role = 'packer' AND active = 1`)
    .bind(packerId, warehouseId)
    .first<{ id: string }>();
  if (!packer) throw new PickerFlowError('not_found', 'That packer was not found (or is inactive)');

  await db.prepare(`UPDATE pick_batches SET status = 'assigned', assigned_picker_id = ? WHERE id = ?`).bind(packerId, batchId).run();
}

export { newId };
