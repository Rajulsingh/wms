import { newId, logAudit, logException } from './db';
import { confirmPick, releaseReservation } from './inventory';
import { createPickBatch } from './orders';
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
 *
 * Batching happens here, at claim time, not when orders arrive. Orders sit
 * as plain "pending" the moment they're imported/entered — nothing batches
 * them automatically on a timer. The first picker who shows up with no
 * batch already waiting is the trigger: sweep every order that's open right
 * now into one fresh batch and hand it to them. This maximizes what one
 * walk covers (whatever piled up since the last batch was claimed) instead
 * of fragmenting into a new small batch every time an Amazon sync happens
 * to land a couple of orders, and it adds no latency — nothing waits any
 * longer than it already would have. See HANDOFF.md.
 */
export async function claimNextBatch(db: D1Database, warehouseId: string, pickerId: string): Promise<string | null> {
  const resumable = await db
    .prepare(
      `SELECT id FROM pick_batches WHERE warehouse_id = ? AND assigned_picker_id = ? AND status IN ('assigned', 'in_progress') ORDER BY created_at ASC LIMIT 1`
    )
    .bind(warehouseId, pickerId)
    .first<{ id: string }>();
  if (resumable) return resumable.id;

  let candidate = await db
    .prepare(`SELECT id FROM pick_batches WHERE warehouse_id = ? AND status = 'pending' ORDER BY created_at ASC LIMIT 1`)
    .bind(warehouseId)
    .first<{ id: string }>();

  if (!candidate) {
    // Cap the sweep at the cart's actual slot count, not an arbitrary number
    // — a batch bigger than the physical cart can hold isn't walkable in one
    // pass anyway. Any orders left over (more open than the cart can carry)
    // simply form the next batch the next time someone claims.
    const cart = await db
      .prepare(`SELECT id, slot_count FROM carts WHERE warehouse_id = ? AND active = 1 LIMIT 1`)
      .bind(warehouseId)
      .first<{ id: string; slot_count: number }>();
    if (!cart) return null;

    const result = await createPickBatch(db, warehouseId, { cartId: cart.id, maxOrders: cart.slot_count });
    if (!result.batchId) return null;
    candidate = { id: result.batchId };
  }

  const result = await db
    .prepare(`UPDATE pick_batches SET status = 'assigned', assigned_picker_id = ? WHERE id = ? AND status = 'pending'`)
    .bind(pickerId, candidate.id)
    .run();
  // changes === 0 means another picker claimed it between our SELECT and UPDATE — caller should retry.
  return result.meta.changes === 1 ? candidate.id : null;
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
         pt.quantity_required,
         pt.quantity_picked,
         pt.status
       FROM pick_tasks pt
       JOIN locations loc ON loc.id = pt.location_id
       LEFT JOIN zones z ON z.id = loc.zone_id
       JOIN skus sk ON sk.id = pt.sku_id
       JOIN order_items oi ON oi.id = pt.order_item_id
       JOIN orders o ON o.id = oi.order_id
       WHERE pt.pick_batch_id = ?
       ORDER BY loc.sequence_number ASC, sk.sku_code ASC`
    )
    .bind(batchId)
    .all<PickListRow>();
  return rows.results;
}

/**
 * Marks one pick-list line as picked (or short, if `quantity` is less than
 * required) directly — no location-confirm or barcode-scan step first. This
 * is the primary path for the simplified flow; `confirmQuantity` still does
 * the actual reservation/inventory work underneath, unchanged.
 */
export async function markPicked(db: D1Database, userId: string, pickTaskId: string, quantity: number): Promise<ConfirmQuantityResult> {
  return confirmQuantity(db, userId, pickTaskId, quantity);
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

/** Consumes the reservation for whatever quantity was actually picked. A short pick doesn't fail the call — it's a legitimate outcome logged as an exception (§6), never a dead end for the picker. */
export async function confirmQuantity(db: D1Database, userId: string, pickTaskId: string, quantity: number): Promise<ConfirmQuantityResult> {
  const task = await db
    .prepare(`SELECT pt.*, sk.id as sku_id_check FROM pick_tasks pt JOIN skus sk ON sk.id = pt.sku_id WHERE pt.id = ?`)
    .bind(pickTaskId)
    .first<{ id: string; pick_batch_id: string; order_item_id: string; sku_id: string; location_id: string; quantity_required: number }>();
  if (!task) throw new PickerFlowError('not_found', 'Pick task not found');
  if (quantity > task.quantity_required) {
    throw new PickerFlowError('over_pick', `Cannot pick more than the required ${task.quantity_required} without a supervisor override`);
  }

  const inventory = await db
    .prepare(`SELECT id FROM inventory WHERE sku_id = ? AND location_id = ?`)
    .bind(task.sku_id, task.location_id)
    .first<{ id: string }>();
  if (!inventory) throw new PickerFlowError('inventory_missing', 'No inventory row for this SKU/location — data integrity issue');

  if (quantity > 0) await confirmPick(db, inventory.id, quantity);
  const shortfall = task.quantity_required - quantity;
  if (shortfall > 0) await releaseReservation(db, inventory.id, shortfall);

  const status = shortfall > 0 ? 'short' : 'picked';
  await db
    .prepare(`UPDATE pick_tasks SET status = ?, quantity_picked = ?, picked_at = datetime('now') WHERE id = ?`)
    .bind(status, quantity, pickTaskId)
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
      notes: `Required ${task.quantity_required}, picked ${quantity}`
    });
  }
  await logAudit(db, { userId, action: 'confirm.quantity', entityType: 'pick_task', entityId: pickTaskId, metadata: { quantity, status } });

  const remaining = await db
    .prepare(`SELECT COUNT(*) as c FROM pick_tasks WHERE pick_batch_id = ? AND status IN ('pending', 'location_confirmed')`)
    .bind(task.pick_batch_id)
    .first<{ c: number }>();
  const batchComplete = (remaining?.c ?? 0) === 0;
  if (batchComplete) {
    await db.prepare(`UPDATE pick_batches SET status = 'completed', completed_at = datetime('now') WHERE id = ?`).bind(task.pick_batch_id).run();
    await db
      .prepare(
        `UPDATE orders SET status = 'picked'
         WHERE id IN (SELECT DISTINCT o.id FROM orders o JOIN order_items oi ON oi.order_id = o.id JOIN pick_tasks pt ON pt.order_item_id = oi.id WHERE pt.pick_batch_id = ?)
         AND status = 'batched'`
      )
      .bind(task.pick_batch_id)
      .run();
  }

  return { status, batchComplete };
}

/** Damaged-item report (§6): pulls the item from sellable inventory and releases its reservation, without blocking the rest of the order. */
export async function reportDamaged(db: D1Database, userId: string, pickTaskId: string, notes?: string): Promise<void> {
  const task = await db
    .prepare(`SELECT id, order_item_id, sku_id, location_id, quantity_required FROM pick_tasks WHERE id = ?`)
    .bind(pickTaskId)
    .first<{ id: string; order_item_id: string; sku_id: string; location_id: string; quantity_required: number }>();
  if (!task) throw new PickerFlowError('not_found', 'Pick task not found');

  const inventory = await db
    .prepare(`SELECT id FROM inventory WHERE sku_id = ? AND location_id = ?`)
    .bind(task.sku_id, task.location_id)
    .first<{ id: string }>();
  if (inventory) {
    await releaseReservation(db, inventory.id, task.quantity_required);
    await db
      .prepare(`UPDATE inventory SET status = 'damaged', version = version + 1 WHERE id = ? AND quantity_reserved = 0`)
      .bind(inventory.id)
      .run();
  }

  await db.prepare(`UPDATE pick_tasks SET status = 'damaged' WHERE id = ?`).bind(pickTaskId).run();
  await db.prepare(`UPDATE order_items SET status = 'short' WHERE id = ?`).bind(task.order_item_id).run();

  const orderItem = await db.prepare(`SELECT order_id FROM order_items WHERE id = ?`).bind(task.order_item_id).first<{ order_id: string }>();
  await logException(db, { type: 'damaged', pickTaskId, orderId: orderItem?.order_id, userId, notes });
  await logAudit(db, { userId, action: 'report.damaged', entityType: 'pick_task', entityId: pickTaskId });
}

export { newId };
