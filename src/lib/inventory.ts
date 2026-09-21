import { newId } from './db';

/**
 * Inventory reservation, without Durable Objects (free Workers plan — see §9/§11
 * of the WMS V2 Workflow Proposal doc). Correctness comes from optimistic
 * concurrency on `inventory.version`: every write is a compare-and-swap
 * (`WHERE id = ? AND version = ?`), so two batches racing for the same units
 * can't both succeed — one wins, the other retries against the row's new state.
 * This is the mechanism behind "prevent two workers from picking the same
 * inventory" (§5) and the wrong-quantity / short-pick safeguards (§6).
 *
 * Durable Objects remain a documented future upgrade (§11) if D1 write
 * contention on a single hot SKU ever becomes a real bottleneck — not needed
 * at MVP volume.
 */

const MAX_CAS_ATTEMPTS = 5;

export class InsufficientStockError extends Error {
  constructor(public skuId: string, public requested: number, public available: number) {
    super(`Insufficient stock for SKU ${skuId}: requested ${requested}, available ${available}`);
  }
}

interface Candidate {
  id: string;
  location_id: string;
  quantity_on_hand: number;
  quantity_reserved: number;
  version: number;
  sequence_number: number;
}

/**
 * Reserves `quantity` units of `skuId` within `warehouseId`, preferring the
 * lowest pick-sequence (primary/nearest) pickable location and falling back
 * to secondary locations if the primary is short (§5: "products stored in
 * multiple locations"). Returns the per-location split so pick tasks can be
 * generated against the actual reserved rows.
 */
export async function reserveInventory(
  db: D1Database,
  skuId: string,
  warehouseId: string,
  quantity: number
): Promise<Array<{ inventoryId: string; locationId: string; quantity: number }>> {
  let remaining = quantity;
  const reservations: Array<{ inventoryId: string; locationId: string; quantity: number }> = [];

  while (remaining > 0) {
    const claimed = await claimFromNextAvailableLocation(db, skuId, warehouseId, remaining, reservations.map((r) => r.inventoryId));
    if (!claimed) {
      const totalAvailable = quantity - remaining;
      // Roll back whatever we already claimed in this call — never leave a partial silent reservation.
      for (const r of reservations) {
        await releaseReservation(db, r.inventoryId, r.quantity);
      }
      throw new InsufficientStockError(skuId, quantity, totalAvailable);
    }
    reservations.push(claimed);
    remaining -= claimed.quantity;
  }

  return reservations;
}

async function claimFromNextAvailableLocation(
  db: D1Database,
  skuId: string,
  warehouseId: string,
  maxWanted: number,
  excludeInventoryIds: string[]
): Promise<{ inventoryId: string; locationId: string; quantity: number } | null> {
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
    const excludeClause = excludeInventoryIds.length
      ? `AND inv.id NOT IN (${excludeInventoryIds.map(() => '?').join(',')})`
      : '';

    const candidate = await db
      .prepare(
        `SELECT inv.id, inv.location_id, inv.quantity_on_hand, inv.quantity_reserved, inv.version, loc.sequence_number
         FROM inventory inv
         JOIN locations loc ON loc.id = inv.location_id
         WHERE inv.sku_id = ?
           AND loc.warehouse_id = ?
           AND loc.type = 'pickable'
           AND inv.status = 'available'
           AND (inv.quantity_on_hand - inv.quantity_reserved) > 0
           ${excludeClause}
         ORDER BY loc.sequence_number ASC
         LIMIT 1`
      )
      .bind(skuId, warehouseId, ...excludeInventoryIds)
      .first<Candidate>();

    if (!candidate) return null;

    const available = candidate.quantity_on_hand - candidate.quantity_reserved;
    const take = Math.min(available, maxWanted);

    const result = await db
      .prepare(
        `UPDATE inventory
         SET quantity_reserved = quantity_reserved + ?, version = version + 1, updated_at = datetime('now')
         WHERE id = ? AND version = ?`
      )
      .bind(take, candidate.id, candidate.version)
      .run();

    if (result.meta.changes === 1) {
      return { inventoryId: candidate.id, locationId: candidate.location_id, quantity: take };
    }
    // version mismatch — someone else claimed from this row between our SELECT and UPDATE; retry.
  }
  throw new Error(`Could not claim inventory for SKU ${skuId} after ${MAX_CAS_ATTEMPTS} attempts — high contention on this SKU.`);
}

/** Releases a reservation without consuming stock — order cancelled, batch cancelled, etc. */
export async function releaseReservation(db: D1Database, inventoryId: string, quantity: number): Promise<void> {
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
    const row = await db
      .prepare(`SELECT version FROM inventory WHERE id = ?`)
      .bind(inventoryId)
      .first<{ version: number }>();
    if (!row) return;

    const result = await db
      .prepare(
        `UPDATE inventory
         SET quantity_reserved = MAX(0, quantity_reserved - ?), version = version + 1, updated_at = datetime('now')
         WHERE id = ? AND version = ?`
      )
      .bind(quantity, inventoryId, row.version)
      .run();
    if (result.meta.changes === 1) return;
  }
  throw new Error(`Could not release reservation for inventory ${inventoryId} after ${MAX_CAS_ATTEMPTS} attempts.`);
}

/**
 * Consumes a reservation at the moment a picker confirms a scanned quantity —
 * moves stock from "reserved" to actually gone (on_hand decreases too).
 * `pickedQuantity` may be less than reserved (a short pick); the caller is
 * responsible for logging the short-pick exception (§6) and releasing the
 * unpicked remainder via `releaseReservation`.
 */
export async function confirmPick(db: D1Database, inventoryId: string, pickedQuantity: number): Promise<void> {
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
    const row = await db
      .prepare(`SELECT version, quantity_on_hand, quantity_reserved FROM inventory WHERE id = ?`)
      .bind(inventoryId)
      .first<{ version: number; quantity_on_hand: number; quantity_reserved: number }>();
    if (!row) throw new Error(`Inventory row ${inventoryId} not found`);

    const result = await db
      .prepare(
        `UPDATE inventory
         SET quantity_on_hand = MAX(0, quantity_on_hand - ?),
             quantity_reserved = MAX(0, quantity_reserved - ?),
             version = version + 1,
             updated_at = datetime('now')
         WHERE id = ? AND version = ?`
      )
      .bind(pickedQuantity, pickedQuantity, inventoryId, row.version)
      .run();
    if (result.meta.changes === 1) return;
  }
  throw new Error(`Could not confirm pick for inventory ${inventoryId} after ${MAX_CAS_ATTEMPTS} attempts.`);
}

/**
 * Reverses confirmPick — puts undone units back on hand *and* re-reserves
 * them, since the pick_task they came from is reopening (going back to
 * 'pending'), not disappearing. Exact mirror of confirmPick's own
 * decrement, same CAS retry shape. See unpickGroupQuantity in
 * lib/picker.ts — this only ever undoes a clean 'picked' task, never a
 * 'short'/'damaged' one (those already carry their own exception trail).
 */
export async function unconfirmPick(db: D1Database, inventoryId: string, quantity: number): Promise<void> {
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
    const row = await db.prepare(`SELECT version FROM inventory WHERE id = ?`).bind(inventoryId).first<{ version: number }>();
    if (!row) throw new Error(`Inventory row ${inventoryId} not found`);

    const result = await db
      .prepare(
        `UPDATE inventory
         SET quantity_on_hand = quantity_on_hand + ?,
             quantity_reserved = quantity_reserved + ?,
             version = version + 1,
             updated_at = datetime('now')
         WHERE id = ? AND version = ?`
      )
      .bind(quantity, quantity, inventoryId, row.version)
      .run();
    if (result.meta.changes === 1) return;
  }
  throw new Error(`Could not reverse pick for inventory ${inventoryId} after ${MAX_CAS_ATTEMPTS} attempts.`);
}

export { newId };
