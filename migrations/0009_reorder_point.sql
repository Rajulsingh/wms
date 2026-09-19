-- Backs the low-stock/reorder alerts on the new inventory reports dashboard
-- (session 2, third round). Nullable — a SKU without one set falls back to
-- a fixed default threshold in the report query rather than being silently
-- excluded from alerts.
ALTER TABLE skus ADD COLUMN reorder_point INTEGER;
