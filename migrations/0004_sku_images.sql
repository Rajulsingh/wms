-- Product image, so pickers/packers can visually confirm an item instead of
-- reading a SKU code — a real ergonomics win when several SKUs look similar.
ALTER TABLE skus ADD COLUMN image_url TEXT;
