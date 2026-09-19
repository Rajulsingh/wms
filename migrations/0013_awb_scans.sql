-- Pure record-keeping log of AWB scans — independent of `awbs` (which is
-- "AWB applied to a shipment", one row per shipment). This is the raw scan
-- event history: what was scanned, which order it got matched to (FIFO —
-- see applyAwbByScan in lib/packer.ts), by whom, and when.
CREATE TABLE awb_scans (
  id TEXT PRIMARY KEY,
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
  awb_code TEXT NOT NULL,
  order_id TEXT REFERENCES orders(id),
  shipment_id TEXT REFERENCES shipments(id),
  scanned_by TEXT REFERENCES users(id),
  scanned_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_awb_scans_warehouse ON awb_scans (warehouse_id, scanned_at);
