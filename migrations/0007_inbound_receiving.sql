-- Inbound receiving & putaway (HANDOFF.md open item 4 — scope confirmed as
-- receiving/putaway, not cycle counting). A receipt is one "stuff arrived"
-- event; its lines are what was put where. Putting stock away increments
-- `inventory.quantity_on_hand` directly (see src/lib/inbound.ts) — this is
-- the counterpart to reserveInventory in inventory.ts, which only ever takes
-- stock out. Existing SKUs created with zero inventory (e.g. a new Amazon
-- SellerSKU auto-created on order import, see orders.ts) get real stock for
-- the first time through this flow.
CREATE TABLE inbound_receipts (
  id TEXT PRIMARY KEY,
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
  received_by TEXT REFERENCES users(id),
  reference TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE inbound_receipt_lines (
  id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL REFERENCES inbound_receipts(id),
  sku_id TEXT NOT NULL REFERENCES skus(id),
  location_id TEXT NOT NULL REFERENCES locations(id),
  quantity INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_inbound_receipt_lines_receipt ON inbound_receipt_lines (receipt_id);
