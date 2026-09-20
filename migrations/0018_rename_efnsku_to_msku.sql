-- Renames the column added in 0017 from `efnsku` to `msku` ("Master SKU") —
-- the user asked for a different name before this concept saw any real
-- production use, so this is a clean rename rather than a data migration.
-- See lib/skus.ts for the (also renamed) assignment/merge-trigger logic.
ALTER TABLE skus RENAME COLUMN efnsku TO msku;
DROP INDEX idx_skus_efnsku;
CREATE UNIQUE INDEX idx_skus_msku ON skus(msku) WHERE msku IS NOT NULL;
