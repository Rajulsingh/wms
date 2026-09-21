-- Merchant-fulfilled returns intake (see HANDOFF.md). Synced from Amazon's
-- Reports API (GET_FLAT_FILE_RETURNS_DATA_BY_RETURN_DATE — the same report
-- Seller Central's own "Manage Returns" page is built from), then inspected
-- on the floor by a packer once the physical package actually arrives.
--
-- The report itself is async (request -> poll -> download, same shape as
-- the EasyShip label feed/report pair in amazon.ts) — these three columns
-- carry one in-flight request per warehouse across cron ticks, mirroring
-- amazon_orders_synced_through's watermark pattern from migration 0024.
ALTER TABLE warehouses ADD COLUMN amazon_returns_synced_through TEXT;
ALTER TABLE warehouses ADD COLUMN returns_report_pending_id TEXT;
ALTER TABLE warehouses ADD COLUMN returns_report_requested_at TEXT;

-- migration 0001 created a `returns` table for an older, never-built
-- concept (order_item-level restocking grading — sellable/damaged/
-- quarantine, no Amazon RMA/tracking/OTP/claim fields at all). Confirmed
-- nothing in src/ ever reads or writes it — dropping it rather than
-- layering a second, differently-shaped table under the same name.
DROP TABLE IF EXISTS returns;

-- order_id/sku_id are nullable and only ever a best-effort match against our
-- own data (by external_order_id and asin/merchant_sku) — a return can
-- arrive for an order this WMS never saw (placed/cancelled before this
-- warehouse went live, or a SKU not yet in our catalog), and that's not an
-- error, just a row with less context to show the packer.
CREATE TABLE returns (
  id TEXT PRIMARY KEY,
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
  order_id TEXT REFERENCES orders(id),
  sku_id TEXT REFERENCES skus(id),
  external_order_id TEXT NOT NULL,
  amazon_rma_id TEXT,
  merchant_rma_id TEXT,
  asin TEXT,
  merchant_sku TEXT,
  item_name TEXT,
  return_reason TEXT,
  tracking_id TEXT,
  return_request_date TEXT,
  return_delivery_date TEXT,
  -- 'expected': synced from Amazon, not yet physically inspected.
  -- 'ready_to_repack' / 'unsellable' / 'safe_to_claim': packer's inspection
  -- outcome (see reportReturnInspection in lib/returns.ts).
  -- 'claim_filed': admin has submitted the SAFE-T claim for a safe_to_claim row.
  status TEXT NOT NULL CHECK (
    status IN ('expected', 'ready_to_repack', 'unsellable', 'safe_to_claim', 'claim_filed')
  ) DEFAULT 'expected',
  label_image_key TEXT,
  product_image_key TEXT,
  inspected_by TEXT REFERENCES users(id),
  inspected_at TEXT,
  claim_filed_by TEXT REFERENCES users(id),
  claim_filed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (warehouse_id, amazon_rma_id)
);
CREATE INDEX idx_returns_warehouse_status ON returns (warehouse_id, status);
CREATE INDEX idx_returns_warehouse_date ON returns (warehouse_id, return_request_date);

-- The courier hand-off OTP for a day's returns is NOT exposed by any SP-API
-- endpoint (verified — the Returns Reports listed at
-- developer-docs.amazon.com/sp-api/docs/report-type-values-returns carry
-- order/RMA/SKU/tracking fields only, no OTP field). It's Seller-Central-UI
-- only, and stays the same for every return handled that day (confirmed by
-- seller). So this is a manual daily value: an admin reads it off Seller
-- Central each morning and enters it once here; the packer's "Get OTP"
-- button just reveals whatever's stored for today, no live Amazon call.
CREATE TABLE return_otps (
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
  otp_date TEXT NOT NULL,
  otp TEXT NOT NULL,
  set_by TEXT NOT NULL REFERENCES users(id),
  set_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (warehouse_id, otp_date)
);
