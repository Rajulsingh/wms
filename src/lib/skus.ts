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
  image_url: string | null;
  asin: string | null;
  merged_into_id: string | null;
}

async function loadMergeable(db: D1Database, sourceCode: string, targetCode: string): Promise<{ source: SkuRef; target: SkuRef }> {
  if (sourceCode === targetCode) throw new SkuMergeError('same_sku', 'Pick two different SKU codes to merge');

  const [source, target] = await Promise.all([
    db.prepare(`SELECT id, sku_code, name, image_url, asin, merged_into_id FROM skus WHERE sku_code = ?`).bind(sourceCode).first<SkuRef>(),
    db.prepare(`SELECT id, sku_code, name, image_url, asin, merged_into_id FROM skus WHERE sku_code = ?`).bind(targetCode).first<SkuRef>()
  ]);
  if (!source) throw new SkuMergeError('not_found', `No SKU found with code "${sourceCode}"`);
  if (!target) throw new SkuMergeError('not_found', `No SKU found with code "${targetCode}"`);
  if (source.merged_into_id) throw new SkuMergeError('already_merged', `"${sourceCode}" was already merged into another SKU`);
  if (target.merged_into_id) throw new SkuMergeError('target_merged', `"${targetCode}" has itself been merged into another SKU — merge into that one instead`);

  return { source, target };
}

export interface SkuMergePreview {
  source: { id: string; code: string; name: string; imageUrl: string | null; asin: string | null };
  target: { id: string; code: string; name: string; imageUrl: string | null; asin: string | null };
  inventoryLines: number;
  inventoryUnits: number;
  orderItemCount: number;
  pickTaskCount: number;
  // True only when BOTH sides have a known ASIN and they differ — a strong
  // signal these are genuinely different products or variations (e.g. a
  // color/size sibling) that happen to share an identical Amazon title, not
  // a real duplicate. Never true just because one side is missing an ASIN.
  asinMismatch: boolean;
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
    source: { id: source.id, code: source.sku_code, name: source.name, imageUrl: source.image_url, asin: source.asin },
    target: { id: target.id, code: target.sku_code, name: target.name, imageUrl: target.image_url, asin: target.asin },
    inventoryLines: inv?.lines ?? 0,
    inventoryUnits: inv?.units ?? 0,
    orderItemCount: oi?.c ?? 0,
    pickTaskCount: pt?.c ?? 0,
    asinMismatch: Boolean(source.asin && target.asin && source.asin !== target.asin)
  };
}

export interface DuplicateSkuCandidate {
  id: string;
  code: string;
  imageUrl: string | null;
  asin: string | null;
  inventoryUnits: number;
  orderItemCount: number;
  createdAt: string;
}

export type DuplicateMatchType = 'same_asin' | 'same_image' | 'same_title';

export interface DuplicateSkuGroup {
  // 'same_asin' — two+ SKU codes share the exact same ASIN. Definitional:
  //   Amazon's ASIN *is* the product identity, so this is certain, not a
  //   guess (the user's "same ASIN have different SKU codes... product is
  //   also same" case).
  // 'same_image' — different (or unknown) ASINs, but the exact same product
  //   photo. Also very strong (real Amazon photos aren't reused by
  //   coincidence across different products), covers the "multiple ASINs
  //   but same images and product" case — e.g. a listing that got
  //   relisted under a new ASIN after suppression.
  // 'same_title' — last-resort fallback for SKUs with no ASIN and no photo
  //   to compare (never synced, or an inactive/removed Amazon listing) —
  //   the only case where a real color/size variation can slip in
  //   undetected, since title text alone can't rule that out.
  matchType: DuplicateMatchType;
  matchValue: string;
  name: string;
  candidates: DuplicateSkuCandidate[];
  suggestedKeepId: string;
  // True when candidates carry two or more distinct known ASINs — only
  // possible on a 'same_image' or 'same_title' group (a 'same_asin' group
  // is that ASIN by construction). Doesn't mean "don't merge" — a seller can
  // legitimately treat real color/size siblings as one fungible warehouse
  // SKU (confirmed against this catalog: see HANDOFF.md) — just "look closer
  // and decide deliberately," since it's also exactly how the exact-title
  // scan mistook a real gun holder variation for a duplicate previously.
  hasAsinMismatch: boolean;
}

interface DupRow {
  id: string;
  sku_code: string;
  name: string;
  image_url: string | null;
  asin: string | null;
  created_at: string;
  inventory_units: number;
  order_item_count: number;
}

function pickSuggestedKeep(candidates: DuplicateSkuCandidate[]): string {
  return candidates.reduce((a, b) => {
    if (a.inventoryUnits !== b.inventoryUnits) return a.inventoryUnits > b.inventoryUnits ? a : b;
    if (a.orderItemCount !== b.orderItemCount) return a.orderItemCount > b.orderItemCount ? a : b;
    return a.createdAt <= b.createdAt ? a : b;
  }).id;
}

function toCandidate(r: DupRow): DuplicateSkuCandidate {
  return {
    id: r.id,
    code: r.sku_code,
    imageUrl: r.image_url,
    asin: r.asin,
    inventoryUnits: r.inventory_units,
    orderItemCount: r.order_item_count,
    createdAt: r.created_at
  };
}

/**
 * Finds SKUs that are almost certainly the same physical product listed
 * under more than one code — the same failure mode that caused the
 * incidents this tool was built for (see HANDOFF.md). ASIN and product
 * photo are the primary signals now, not title: a title match alone can't
 * tell a real duplicate apart from a real color/size variation that
 * happens to share the same generic listing title (confirmed against this
 * catalog — several genuine variations were nearly merged on title alone
 * before ASIN/photo comparison caught it). Checked in order of confidence,
 * and a SKU already placed in a stronger group is never re-flagged by a
 * weaker one:
 *   1. same_asin  — certain (ASIN is Amazon's own product identity)
 *   2. same_image — very strong (real product photos aren't reused by
 *                   coincidence); catches a product relisted under a new
 *                   ASIN, which same_asin alone would miss
 *   3. same_title — last resort, only for SKUs with neither ASIN nor photo
 *                   on file (never synced, or an inactive Amazon listing)
 * `suggestedKeepId` prefers whichever candidate already has stock, then
 * whichever has more order history, then whichever is older — it's only a
 * suggestion; admin picks the actual pair to merge.
 */
export async function findDuplicateSkus(db: D1Database): Promise<DuplicateSkuGroup[]> {
  const rows = await db
    .prepare(
      `SELECT s.id, s.sku_code, s.name, s.image_url, s.asin, s.created_at,
              COALESCE((SELECT SUM(quantity_on_hand) FROM inventory WHERE sku_id = s.id), 0) AS inventory_units,
              (SELECT COUNT(*) FROM order_items WHERE sku_id = s.id) AS order_item_count
       FROM skus s
       WHERE s.merged_into_id IS NULL`
    )
    .all<DupRow>();

  const placed = new Set<string>();
  const groups: DuplicateSkuGroup[] = [];

  function groupBy(source: DupRow[], keyOf: (r: DupRow) => string | null, matchType: DuplicateMatchType) {
    const byKey = new Map<string, DupRow[]>();
    for (const r of source) {
      if (placed.has(r.id)) continue;
      const key = keyOf(r);
      if (!key) continue;
      const list = byKey.get(key) ?? [];
      list.push(r);
      byKey.set(key, list);
    }
    for (const [key, members] of byKey) {
      if (members.length < 2) continue;
      const candidates = members.map(toCandidate);
      const knownAsins = new Set(candidates.map((c) => c.asin).filter((a): a is string => Boolean(a)));
      groups.push({
        matchType,
        matchValue: key,
        name: members[0].name,
        candidates,
        suggestedKeepId: pickSuggestedKeep(candidates),
        hasAsinMismatch: knownAsins.size > 1
      });
      for (const m of members) placed.add(m.id);
    }
  }

  groupBy(rows.results, (r) => r.asin, 'same_asin');
  groupBy(rows.results, (r) => r.image_url, 'same_image');
  groupBy(rows.results, (r) => r.name.trim().toLowerCase(), 'same_title');

  return groups;
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

export interface SkuUnmergePreview {
  source: { id: string; code: string; name: string; imageUrl: string | null; asin: string | null };
  target: { id: string; code: string; name: string; imageUrl: string | null; asin: string | null };
  // What currently sits under the target's own id — NOT what would move back.
  // Unmerging never moves inventory/orders automatically (see unmergeSku):
  // once merged, a target's own pre-existing data and anything genuinely
  // moved from the source are indistinguishable from each other, so this is
  // shown only as context for the admin to judge, not a promise of what
  // unmerging will change.
  targetInventoryLines: number;
  targetInventoryUnits: number;
  targetOrderItemCount: number;
}

async function loadUnmergeable(db: D1Database, sourceCode: string): Promise<{ source: SkuRef; target: SkuRef }> {
  const source = await db.prepare(`SELECT id, sku_code, name, image_url, asin, merged_into_id FROM skus WHERE sku_code = ?`).bind(sourceCode).first<SkuRef>();
  if (!source) throw new SkuMergeError('not_found', `No SKU found with code "${sourceCode}"`);
  if (!source.merged_into_id) throw new SkuMergeError('not_merged', `"${sourceCode}" isn't currently merged into anything`);
  const target = await db.prepare(`SELECT id, sku_code, name, image_url, asin, merged_into_id FROM skus WHERE id = ?`).bind(source.merged_into_id).first<SkuRef>();
  if (!target) throw new SkuMergeError('not_found', `"${sourceCode}"'s merge target no longer exists`);
  return { source, target };
}

/** Read-only — shows what a SKU is currently merged into, plus context on the target, before committing to unmerge. */
export async function previewSkuUnmerge(db: D1Database, sourceCode: string): Promise<SkuUnmergePreview> {
  const { source, target } = await loadUnmergeable(db, sourceCode);

  const [inv, oi] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS lines, COALESCE(SUM(quantity_on_hand), 0) AS units FROM inventory WHERE sku_id = ?`).bind(target.id).first<{ lines: number; units: number }>(),
    db.prepare(`SELECT COUNT(*) AS c FROM order_items WHERE sku_id = ?`).bind(target.id).first<{ c: number }>()
  ]);

  return {
    source: { id: source.id, code: source.sku_code, name: source.name, imageUrl: source.image_url, asin: source.asin },
    target: { id: target.id, code: target.sku_code, name: target.name, imageUrl: target.image_url, asin: target.asin },
    targetInventoryLines: inv?.lines ?? 0,
    targetInventoryUnits: inv?.units ?? 0,
    targetOrderItemCount: oi?.c ?? 0
  };
}

export interface SkuUnmergeResult {
  sourceCode: string;
  wasTargetCode: string;
}

/**
 * Reverses a merge by clearing `merged_into_id` — nothing else. Deliberately
 * does NOT try to move any inventory/order_items/pick_tasks back to the
 * source: once merged, there is no reliable way to tell which of the
 * target's current rows were always its own vs. genuinely moved from the
 * source (mergeSku sums same-location inventory into the target's existing
 * row and deletes the source's, and order_items/pick_tasks are simply
 * repointed with no marker of where they came from) — a blind "move it all
 * back" would be just as much a guess as the original wrong merge, only in
 * the other direction. If real inventory or orders need to be separated back
 * out, that takes the same manual, evidence-based check done for the
 * production incidents this was built from (see HANDOFF.md): cross-reference
 * against Amazon's own order records before moving anything.
 */
export async function unmergeSku(db: D1Database, userId: string, sourceCode: string): Promise<SkuUnmergeResult> {
  const { source, target } = await loadUnmergeable(db, sourceCode);

  await db.prepare(`UPDATE skus SET merged_into_id = NULL WHERE id = ?`).bind(source.id).run();

  await logAudit(db, {
    userId,
    action: 'sku.unmerge',
    entityType: 'sku',
    entityId: source.id,
    metadata: { sourceCode: source.sku_code, wasTargetCode: target.sku_code }
  });

  return { sourceCode: source.sku_code, wasTargetCode: target.sku_code };
}
