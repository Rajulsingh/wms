import { newId } from './db';
import { fetchAllListings } from './amazon';

export interface CatalogSyncResult {
  created: number;
  updated: number;
  skippedParent: number;
  total: number;
}

export interface CatalogSyncProgress {
  processed: number;
  total: number | null; // null until at least one page has come back — pagination total isn't known upfront
}

/**
 * Upserts every active Amazon listing into the local `skus` table. Amazon
 * is treated as authoritative for name/image here — same as the
 * auto-create-on-order-import path in orders.ts — but `price` and
 * `reorder_point` are admin-owned fields and are never touched by this
 * sync, only name/image_url/asin.
 *
 * Also persists the ASIN now (previously fetched by fetchAllListings and
 * silently discarded) — it's the one signal that still distinguishes two
 * SKUs whose Amazon titles are byte-identical but are actually different
 * products or variations, which the exact-name duplicate scan (skus.ts)
 * can't tell apart from title alone.
 *
 * Deliberately does NOT follow a merge redirect the way order import's
 * `resolveSkuIdByCode` does — found via a real production incident (see
 * HANDOFF.md): if `listing.sku` is a code that's been merged away, its Amazon
 * listing usually didn't disappear, and every sync would silently overwrite
 * the *surviving* SKU's real name/image/asin with the *retired* code's data
 * (or vice versa, depending on pagination order that run) — corrupting
 * whichever one happened to sync last. A merged-away code's own listing data
 * describes a different product/variation than the survivor now represents,
 * so it must never be written onto the survivor's row. The lookup below is
 * always by `sku_code = listing.sku` directly (never resolved through a
 * merge redirect), so `existing.id` is always that exact row's own id —
 * writing to it is always safe and correct regardless of whether that row
 * happens to be merged into something else. Keeping a merged-away row's own
 * name/image/asin fresh (rather than skipping it) matters: it's the only way
 * that row's data stays trustworthy for later duplicate-detection/ASIN
 * comparisons (skus.ts) instead of going permanently stale the moment it's
 * merged.
 *
 * `onProgress` fires after each page of listings is fetched *and* written,
 * not just fetched — so a caller streaming this to a progress bar reports
 * what's actually been persisted, not just downloaded.
 *
 * Parent (variation-family) listings are never treated as ordinary products:
 * Amazon never marks one BUYABLE (see ListingSummary.buyable in amazon.ts,
 * confirmed against this seller's real catalog — 58 of 227 listings were
 * parent-only) since only its children can actually be ordered or hold
 * inventory. A brand-new parent SellerSKU is skipped entirely — there is
 * nothing useful to create a `skus` row for. One that's already a row here
 * (some carry real inventory/order history from *before* the seller turned
 * them into a parent of a new variation family — confirmed: `KTN4` and
 * `KTN-3W` both still have real stock and, for KTN4, an open pick task) is
 * left alone functionally — its name/image/asin are never touched, since a
 * parent listing's own title/photo describe the whole family, not
 * specifically the product this row's history is about — but is flagged
 * `is_parent_asin` so duplicate-scan (skus.ts) can exclude it from being
 * treated as a fresh candidate without touching anything it's already doing.
 */
export async function syncAmazonCatalog(db: D1Database, onProgress?: (p: CatalogSyncProgress) => void | Promise<void>): Promise<CatalogSyncResult> {
  let created = 0;
  let updated = 0;
  let skippedParent = 0;
  let processed = 0;

  const listings = await fetchAllListings(async (pageItems) => {
    for (const listing of pageItems) {
      if (!listing.title) continue; // nothing useful to store yet

      const existing = await db.prepare(`SELECT id FROM skus WHERE sku_code = ?`).bind(listing.sku).first<{ id: string }>();

      if (!listing.buyable) {
        if (existing) {
          await db.prepare(`UPDATE skus SET is_parent_asin = 1 WHERE id = ? AND is_parent_asin = 0`).bind(existing.id).run();
        }
        skippedParent++;
        continue;
      }

      if (!existing) {
        await db
          .prepare(`INSERT INTO skus (id, sku_code, name, image_url, asin) VALUES (?, ?, ?, ?, ?)`)
          .bind(newId(), listing.sku, listing.title, listing.imageUrl, listing.asin)
          .run();
        created++;
      } else {
        await db
          .prepare(`UPDATE skus SET name = ?, image_url = ?, asin = COALESCE(?, asin), is_parent_asin = 0 WHERE id = ?`)
          .bind(listing.title, listing.imageUrl, listing.asin, existing.id)
          .run();
        updated++;
      }
    }
    processed += pageItems.length;
    if (onProgress) await onProgress({ processed, total: null });
  });

  return { created, updated, skippedParent, total: listings.length };
}
