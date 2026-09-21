-- Daily headcount reconciliation, separate from inspecting individual
-- returns (see lib/returns.ts). A packer needs to know how many returns
-- Amazon expects today *before* requesting the OTP (so they can sanity-check
-- what the courier hands over), then confirm how many actually arrived —
-- Amazon's own expected count can differ from the physical handover (a
-- return genuinely not sent, one bundled in that wasn't expected). The
-- inspect-and-update-status step only unlocks once today's count is
-- confirmed — see hasConfirmedReceiptToday in lib/returns.ts.
CREATE TABLE return_receipts (
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
  receipt_date TEXT NOT NULL,
  expected_count INTEGER NOT NULL,
  received_count INTEGER NOT NULL,
  confirmed_by TEXT NOT NULL REFERENCES users(id),
  confirmed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (warehouse_id, receipt_date)
);
