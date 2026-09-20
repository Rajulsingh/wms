import { newId } from './db';
import { fetchAllListings } from './amazon';
import { resolveSkuIdByCode } from './skus';

export interface CatalogSyncResult {
  created: number;
  updated: number;
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
 * `onProgress` fires after each page of listings is fetched *and* written,
 * not just fetched — so a caller streaming this to a progress bar reports
 * what's actually been persisted, not just downloaded.
 */
export async function syncAmazonCatalog(db: D1Database, onProgress?: (p: CatalogSyncProgress) => void | Promise<void>): Promise<CatalogSyncResult> {
  let created = 0;
  let updated = 0;
  let processed = 0;

  const listings = await fetchAllListings(async (pageItems) => {
    for (const listing of pageItems) {
      if (!listing.title) continue; // nothing useful to store yet

      // Follows a merge redirect — if this SellerSKU is a duplicate that's
      // since been merged into another SKU, the catalog's name/image update
      // applies to the surviving SKU, not the dead one. See lib/skus.ts.
      const resolvedId = await resolveSkuIdByCode(db, listing.sku);
      if (resolvedId) {
        await db
          .prepare(`UPDATE skus SET name = ?, image_url = ?, asin = COALESCE(?, asin) WHERE id = ?`)
          .bind(listing.title, listing.imageUrl, listing.asin, resolvedId)
          .run();
        updated++;
      } else {
        await db
          .prepare(`INSERT INTO skus (id, sku_code, name, image_url, asin) VALUES (?, ?, ?, ?, ?)`)
          .bind(newId(), listing.sku, listing.title, listing.imageUrl, listing.asin)
          .run();
        created++;
      }
    }
    processed += pageItems.length;
    if (onProgress) await onProgress({ processed, total: null });
  });

  return { created, updated, total: listings.length };
}
