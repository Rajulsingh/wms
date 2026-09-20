import { newId } from './db';
import { fetchAllListings } from './amazon';

export interface CatalogSyncResult {
  created: number;
  updated: number;
  skippedMerged: number;
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
 * so it must never be written onto the survivor's row. Instead: only write
 * name/image/asin to a SKU when `listing.sku` is that exact row's own,
 * current, non-merged code; a listing whose code has been merged away is
 * counted in `skippedMerged` and otherwise ignored (not recreated either —
 * that's still resolveSkuIdByCode's job, just not used for the write here).
 *
 * `onProgress` fires after each page of listings is fetched *and* written,
 * not just fetched — so a caller streaming this to a progress bar reports
 * what's actually been persisted, not just downloaded.
 */
export async function syncAmazonCatalog(db: D1Database, onProgress?: (p: CatalogSyncProgress) => void | Promise<void>): Promise<CatalogSyncResult> {
  let created = 0;
  let updated = 0;
  let skippedMerged = 0;
  let processed = 0;

  const listings = await fetchAllListings(async (pageItems) => {
    for (const listing of pageItems) {
      if (!listing.title) continue; // nothing useful to store yet

      const existing = await db
        .prepare(`SELECT id, merged_into_id FROM skus WHERE sku_code = ?`)
        .bind(listing.sku)
        .first<{ id: string; merged_into_id: string | null }>();

      if (!existing) {
        await db
          .prepare(`INSERT INTO skus (id, sku_code, name, image_url, asin) VALUES (?, ?, ?, ?, ?)`)
          .bind(newId(), listing.sku, listing.title, listing.imageUrl, listing.asin)
          .run();
        created++;
      } else if (existing.merged_into_id) {
        skippedMerged++;
      } else {
        await db
          .prepare(`UPDATE skus SET name = ?, image_url = ?, asin = COALESCE(?, asin) WHERE id = ?`)
          .bind(listing.title, listing.imageUrl, listing.asin, existing.id)
          .run();
        updated++;
      }
    }
    processed += pageItems.length;
    if (onProgress) await onProgress({ processed, total: null });
  });

  return { created, updated, skippedMerged, total: listings.length };
}
