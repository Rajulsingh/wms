import { logAudit } from './db';

export class SkuMergeError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

/**
 * Resolves a sku_code to the SKU it should actually be treated as — follows
 * `merged_into_id` if that code belongs to a SKU that's since been merged
 * into another one. Every place that auto-creates a SKU from an incoming
 * sku_code (Amazon order import, catalog sync, receiving's "new SKU code")
 * must go through this instead of a bare `WHERE sku_code = ?` lookup —
 * otherwise a merged-away duplicate's code re-appearing (e.g. the same
 * SellerSKU on a future Amazon order) spawns a second, empty duplicate all
 * over again, defeating the merge. Returns null if no SKU has this code at
 * all — the caller decides whether to create one.
 */
export async function resolveSkuIdByCode(db: D1Database, skuCode: string): Promise<string | null> {
  const row = await db
    .prepare(`SELECT id, merged_into_id FROM skus WHERE sku_code = ?`)
    .bind(skuCode)
    .first<{ id: string; merged_into_id: string | null }>();
  if (!row) return null;
  return row.merged_into_id ?? row.id;
}

interface SkuRef {
  id: string;
  sku_code: string;
  name: string;
  merged_into_id: string | null;
}

async function loadMergeable(db: D1Database, sourceCode: string, targetCode: string): Promise<{ source: SkuRef; target: SkuRef }> {
  if (sourceCode === targetCode) throw new SkuMergeError('same_sku', 'Pick two different SKU codes to merge');

  const [source, target] = await Promise.all([
    db.prepare(`SELECT id, sku_code, name, merged_into_id FROM skus WHERE sku_code = ?`).bind(sourceCode).first<SkuRef>(),
    db.prepare(`SELECT id, sku_code, name, merged_into_id FROM skus WHERE sku_code = ?`).bind(targetCode).first<SkuRef>()
  ]);
  if (!source) throw new SkuMergeError('not_found', `No SKU found with code "${sourceCode}"`);
  if (!target) throw new SkuMergeError('not_found', `No SKU found with code "${targetCode}"`);
  if (source.merged_into_id) throw new SkuMergeError('already_merged', `"${sourceCode}" was already merged into another SKU`);
  if (target.merged_into_id) throw new SkuMergeError('target_merged', `"${targetCode}" has itself been merged into another SKU — merge into that one instead`);

  return { source, target };
}

export interface SkuMergePreview {
  source: { id: string; code: string; name: string };
  target: { id: string; code: string; name: string };
  inventoryLines: number;
  inventoryUnits: number;
  orderItemCount: number;
  pickTaskCount: number;
}

/** Read-only — what a merge of these two codes would move, so admin can see it before committing. */
export async function previewSkuMerge(db: D1Database, sourceCode: string, targetCode: string): Promise<SkuMergePreview> {
  const { source, target } = await loadMergeable(db, sourceCode, targetCode);

  const [inv, oi, pt] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS lines, COALESCE(SUM(quantity_on_hand), 0) AS units FROM inventory WHERE sku_id = ?`).bind(source.id).first<{ lines: number; units: number }>(),
    db.prepare(`SELECT COUNT(*) AS c FROM order_items WHERE sku_id = ?`).bind(source.id).first<{ c: number }>(),
    db.prepare(`SELECT COUNT(*) AS c FROM pick_tasks WHERE sku_id = ?`).bind(source.id).first<{ c: number }>()
  ]);

  return {
    source: { id: source.id, code: source.sku_code, name: source.name },
    target: { id: target.id, code: target.sku_code, name: target.name },
    inventoryLines: inv?.lines ?? 0,
    inventoryUnits: inv?.units ?? 0,
    orderItemCount: oi?.c ?? 0,
    pickTaskCount: pt?.c ?? 0
  };
}

export interface DuplicateSkuCandidate {
  id: string;
  code: string;
  inventoryUnits: number;
  orderItemCount: number;
  createdAt: string;
}

export interface DuplicateSkuGroup {
  name: string;
  candidates: DuplicateSkuCandidate[];
  suggestedKeepId: string;
}

/**
 * Finds SKUs that are almost certainly the same physical product listed
 * under more than one code — the same failure mode that caused the incident
 * this tool was built for (see HANDOFF.md, "a real production bug"), just
 * discovered proactively instead of one stock-out error at a time. Groups
 * by exact, case/whitespace-normalized product name — deliberately not a
 * fuzzy/similarity match, since a false positive here means merging two
 * SKUs that turn out to be genuinely different products, which is a real
 * mutation. Amazon listing titles are precise enough that two unrelated
 * products sharing byte-identical text is effectively impossible in
 * practice, whereas a small title variation (e.g. one has a "(Classic)"
 * suffix) is common for true duplicates too — those won't be caught here,
 * only exact matches. `suggestedKeepId` prefers whichever candidate already
 * has stock, then whichever has more order history, then whichever is
 * older — but it's only a suggestion; admin picks the actual pair to merge.
 */
export async function findDuplicateSkus(db: D1Database): Promise<DuplicateSkuGroup[]> {
  const rows = await db
    .prepare(
      `SELECT s.id, s.sku_code, s.name, s.created_at,
              COALESCE((SELECT SUM(quantity_on_hand) FROM inventory WHERE sku_id = s.id), 0) AS inventory_units,
              (SELECT COUNT(*) FROM order_items WHERE sku_id = s.id) AS order_item_count
       FROM skus s
       WHERE s.merged_into_id IS NULL
         AND TRIM(LOWER(s.name)) IN (
           SELECT TRIM(LOWER(name)) FROM skus WHERE merged_into_id IS NULL GROUP BY TRIM(LOWER(name)) HAVING COUNT(*) > 1
         )
       ORDER BY TRIM(LOWER(s.name)), s.created_at ASC`
    )
    .all<{ id: string; sku_code: string; name: string; created_at: string; inventory_units: number; order_item_count: number }>();

  const groups = new Map<string, DuplicateSkuGroup>();
  for (const r of rows.results) {
    const key = r.name.trim().toLowerCase();
    let g = groups.get(key);
    if (!g) {
      g = { name: r.name, candidates: [], suggestedKeepId: '' };
      groups.set(key, g);
    }
    g.candidates.push({ id: r.id, code: r.sku_code, inventoryUnits: r.inventory_units, orderItemCount: r.order_item_count, createdAt: r.created_at });
  }
  for (const g of groups.values()) {
    const best = g.candidates.reduce((a, b) => {
      if (a.inventoryUnits !== b.inventoryUnits) return a.inventoryUnits > b.inventoryUnits ? a : b;
      if (a.orderItemCount !== b.orderItemCount) return a.orderItemCount > b.orderItemCount ? a : b;
      return a.createdAt <= b.createdAt ? a : b;
    });
    g.suggestedKeepId = best.id;
  }
  return Array.from(groups.values());
}

export interface SkuMergeResult {
  inventoryLinesMoved: number;
  unitsMoved: number;
  orderItemsMoved: number;
  pickTasksMoved: number;
}

/**
 * Merges `sourceCode` into `targetCode` — every inventory row, order_item,
 * and pick_task pointing at the source is repointed at the target (inventory
 * rows that would collide at the same location are summed into the
 * target's existing row instead, since (sku_id, location_id) is unique).
 * The source SKU row itself is never deleted — only flagged via
 * `merged_into_id` — so its code keeps resolving correctly through
 * `resolveSkuIdByCode` instead of spawning a fresh duplicate if it shows up
 * again on a future order. Nothing here is a hard delete; a mis-merge can
 * still be manually corrected by an admin who understands the schema, even
 * though there's no one-click "undo" in the UI.
 */
export async function mergeSku(db: D1Database, userId: string, sourceCode: string, targetCode: string): Promise<SkuMergeResult> {
  const { source, target } = await loadMergeable(db, sourceCode, targetCode);

  const sourceInv = await db
    .prepare(`SELECT id, location_id, quantity_on_hand, quantity_reserved FROM inventory WHERE sku_id = ?`)
    .bind(source.id)
    .all<{ id: string; location_id: string; quantity_on_hand: number; quantity_reserved: number }>();

  let unitsMoved = 0;
  for (const row of sourceInv.results) {
    unitsMoved += row.quantity_on_hand;
    const existingTarget = await db
      .prepare(`SELECT id FROM inventory WHERE sku_id = ? AND location_id = ?`)
      .bind(target.id, row.location_id)
      .first<{ id: string }>();
    if (existingTarget) {
      await db
        .prepare(
          `UPDATE inventory SET quantity_on_hand = quantity_on_hand + ?, quantity_reserved = quantity_reserved + ?, version = version + 1, updated_at = datetime('now') WHERE id = ?`
        )
        .bind(row.quantity_on_hand, row.quantity_reserved, existingTarget.id)
        .run();
      await db.prepare(`DELETE FROM inventory WHERE id = ?`).bind(row.id).run();
    } else {
      await db.prepare(`UPDATE inventory SET sku_id = ? WHERE id = ?`).bind(target.id, row.id).run();
    }
  }

  const orderItems = await db.prepare(`UPDATE order_items SET sku_id = ? WHERE sku_id = ?`).bind(target.id, source.id).run();
  const pickTasks = await db.prepare(`UPDATE pick_tasks SET sku_id = ? WHERE sku_id = ?`).bind(target.id, source.id).run();

  await db.prepare(`UPDATE skus SET merged_into_id = ? WHERE id = ?`).bind(target.id, source.id).run();

  const result: SkuMergeResult = {
    inventoryLinesMoved: sourceInv.results.length,
    unitsMoved,
    orderItemsMoved: orderItems.meta.changes,
    pickTasksMoved: pickTasks.meta.changes
  };

  await logAudit(db, {
    userId,
    action: 'sku.merge',
    entityType: 'sku',
    entityId: source.id,
    metadata: { sourceCode: source.sku_code, targetId: target.id, targetCode: target.sku_code, ...result }
  });

  return result;
}
