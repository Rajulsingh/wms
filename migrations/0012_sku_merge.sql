-- Lets admin merge a duplicate SKU (same physical product, different SKU
-- code — typically because Amazon sent a SellerSKU that doesn't match the
-- code already used for that product) into the one actually stocked.
-- Nothing is deleted: the source SKU row survives with merged_into_id set,
-- so its sku_code keeps resolving correctly (for a future Amazon order that
-- references it again) instead of silently spawning a second duplicate.
ALTER TABLE skus ADD COLUMN merged_into_id TEXT REFERENCES skus(id);
