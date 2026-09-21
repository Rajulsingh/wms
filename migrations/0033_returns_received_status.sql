-- Adds a 'received' status between 'expected' and the inspection outcomes —
-- see confirmTodayReceipt in lib/returns.ts. Previously the daily headcount
-- confirmation only recorded a number (return_receipts) without touching
-- any individual return row, so every return stayed 'expected' forever
-- until someone inspected it — a real bug found live: the packer's
-- "Expected returns today" count kept showing the same accumulated
-- backlog day after day, including returns already confirmed received on
-- an earlier day, because nothing ever moved them out of 'expected'.
-- Confirming receipt now moves the oldest N 'expected' rows into
-- 'received', so 'expected' genuinely means "not yet confirmed received"
-- and stops re-surfacing stale entries. SQLite can't ALTER a CHECK
-- constraint in place, so the table is rebuilt (same pattern as migration
-- 0002).
CREATE TABLE returns_new (
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
  status TEXT NOT NULL CHECK (
    status IN ('expected', 'received', 'ready_to_repack', 'unsellable', 'safe_to_claim', 'claim_filed')
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

INSERT INTO returns_new SELECT * FROM returns;
DROP TABLE returns;
ALTER TABLE returns_new RENAME TO returns;

CREATE INDEX idx_returns_warehouse_status ON returns (warehouse_id, status);
CREATE INDEX idx_returns_warehouse_date ON returns (warehouse_id, return_request_date);

-- One-time backfill: the 20 returns already synced in production came in
-- via the very first sync, before the date-format bug (see amazon.ts /
-- lib/returns.ts) was caught — Amazon's actual return_request_date is
-- "DD-Mon-YYYY" text ("02-Sep-2026"), not the ISO format the rest of this
-- app assumes everywhere else. Normalizing existing rows here so sorting
-- and display are correct immediately, not just for future syncs (the
-- upsert's own ON CONFLICT never touches return_request_date after the
-- first insert, so re-syncing alone would never have fixed these).
-- Only the confirmed-live "DD-Mon-YYYY" (2-digit, zero-padded day) shape is
-- rewritten — matching exactly what real production rows had, both zero-
-- padded ("02-Sep-2026", "31-Aug-2026"). A row in some other shape is left
-- untouched rather than guessed at.
UPDATE returns
SET return_request_date = substr(return_request_date, 8, 4) || '-' ||
  CASE substr(return_request_date, 4, 3)
    WHEN 'Jan' THEN '01' WHEN 'Feb' THEN '02' WHEN 'Mar' THEN '03' WHEN 'Apr' THEN '04'
    WHEN 'May' THEN '05' WHEN 'Jun' THEN '06' WHEN 'Jul' THEN '07' WHEN 'Aug' THEN '08'
    WHEN 'Sep' THEN '09' WHEN 'Oct' THEN '10' WHEN 'Nov' THEN '11' WHEN 'Dec' THEN '12'
  END || '-' || substr(return_request_date, 1, 2)
WHERE length(return_request_date) = 11 AND substr(return_request_date, 3, 1) = '-' AND substr(return_request_date, 7, 1) = '-';

UPDATE returns
SET return_delivery_date = substr(return_delivery_date, 8, 4) || '-' ||
  CASE substr(return_delivery_date, 4, 3)
    WHEN 'Jan' THEN '01' WHEN 'Feb' THEN '02' WHEN 'Mar' THEN '03' WHEN 'Apr' THEN '04'
    WHEN 'May' THEN '05' WHEN 'Jun' THEN '06' WHEN 'Jul' THEN '07' WHEN 'Aug' THEN '08'
    WHEN 'Sep' THEN '09' WHEN 'Oct' THEN '10' WHEN 'Nov' THEN '11' WHEN 'Dec' THEN '12'
  END || '-' || substr(return_delivery_date, 1, 2)
WHERE length(return_delivery_date) = 11 AND substr(return_delivery_date, 3, 1) = '-' AND substr(return_delivery_date, 7, 1) = '-';
