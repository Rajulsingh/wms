-- Labels each pick_batches row with the IST calendar date it's grouped
-- under (see computeShipByIstDate in lib/orders.ts) — lets a picker's
-- "Activate pick list" gate offer today's and tomorrow's picklists as
-- separate, independently-activatable units instead of a single same-day-
-- only gate that held near-term orders back until their exact ship-by date.
ALTER TABLE pick_batches ADD COLUMN ship_by_date TEXT;

CREATE INDEX idx_pick_batches_ship_by_date ON pick_batches(warehouse_id, ship_by_date);
