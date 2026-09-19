import { newId } from './db';
import { fetchAllListings } from './amazon';
import { resolveSkuIdByCode } from './skus';

export interface CatalogSyncResult {
  created: number;
  updated: number;
  total: number;
}

/**
 * Upserts every active Amazon listing into the local `skus` table. Amazon
 * is treated as authoritative for name/image here — same as the
 * auto-create-on-order-import path in orders.ts — but `price` and
 * `reorder_point` are admin-owned fields and are never touched by this
 * sync, only name/image_url.
 */
export async function syncAmazonCatalog(db: D1Database): Promise<CatalogSyncResult> {
  const listings = await fetchAllListings();
  let created = 0;
  let updated = 0;

  for (const listing of listings) {
    if (!listing.title) continue; // nothing useful to store yet

    // Follows a merge redirect — if this SellerSKU is a duplicate that's
    // since been merged into another SKU, the catalog's name/image update
    // applies to the surviving SKU, not the dead one. See lib/skus.ts.
    const resolvedId = await resolveSkuIdByCode(db, listing.sku);
    if (resolvedId) {
      await db.prepare(`UPDATE skus SET name = ?, image_url = ? WHERE id = ?`).bind(listing.title, listing.imageUrl, resolvedId).run();
      updated++;
    } else {
      await db
        .prepare(`INSERT INTO skus (id, sku_code, name, image_url) VALUES (?, ?, ?, ?)`)
        .bind(newId(), listing.sku, listing.title, listing.imageUrl)
        .run();
      created++;
    }
  }

  return { created, updated, total: listings.length };
}
