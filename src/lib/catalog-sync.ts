import { newId } from './db';
import { fetchAllListings } from './amazon';

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

    const existing = await db.prepare(`SELECT id FROM skus WHERE sku_code = ?`).bind(listing.sku).first<{ id: string }>();
    if (existing) {
      await db.prepare(`UPDATE skus SET name = ?, image_url = ? WHERE id = ?`).bind(listing.title, listing.imageUrl, existing.id).run();
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
