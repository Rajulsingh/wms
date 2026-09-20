-- Stores the Amazon ASIN alongside each SKU. Both the order-import path and
-- the full-catalog sync already fetch the ASIN from Amazon (amazon.ts) but
-- previously threw it away — it's the one structural signal that survives
-- even when two genuinely different products/variations share an identical
-- title (confirmed against production data: two already-merged SKU pairs
-- had matching titles but different photos, meaning the exact-name duplicate
-- scan can't tell a real duplicate from a same-title variation on title
-- alone). Nullable — older SKUs and anything entered manually never had one.
ALTER TABLE skus ADD COLUMN asin TEXT;
