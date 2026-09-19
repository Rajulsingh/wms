-- Manual (file-based) Easy Ship — generating the Schedule Pickup file Amazon's
-- Seller Central Order Upload accepts, and later matching the label+invoice PDF
-- downloaded back from there to the orders it covers. Parallel to, and
-- independent of, the SP-API Easy Ship path in shipping.ts/amazon.ts.
CREATE TABLE schedule_pickup_batches (
  id TEXT PRIMARY KEY,
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
  pickup_date TEXT NOT NULL,
  pickup_time TEXT NOT NULL CHECK (pickup_time IN ('11:00 AM', '2:00 PM')),
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE shipments ADD COLUMN invoice_id TEXT;
ALTER TABLE shipments ADD COLUMN schedule_batch_id TEXT REFERENCES schedule_pickup_batches(id);
-- Free-form, no CHECK — this tracks the manual file/upload sub-state without
-- touching shipments.status's existing enum, which 'label_applied' already
-- covers loosely enough (see scheduleEasyShipForOrder in shipping.ts).
-- 'file_generated' -> 'labels_received'.
ALTER TABLE shipments ADD COLUMN manual_schedule_status TEXT;
