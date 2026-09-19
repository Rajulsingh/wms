-- Session 2 (continued): the seller confirmed they actually ship via Amazon's
-- EasyShip program (Amazon arranges pickup), not the classic Merchant
-- Fulfillment Network (MFN) the original shipping.ts/amazon.ts were built
-- against — that mismatch is the real reason getEligibleShippingServices
-- kept 403ing (see HANDOFF open item 1). EasyShip is a different, mostly
-- async flow: listHandoverSlots -> createScheduledPackage (no label in the
-- response) -> a separate Feeds+Reports pipeline to actually retrieve the
-- label PDF. These columns track that multi-step state on the shipment row.
-- The MFN code in amazon.ts/shipping.ts is left in place but unused — see
-- the comment at the top of amazon.ts.
ALTER TABLE shipments ADD COLUMN package_identifier TEXT;
ALTER TABLE shipments ADD COLUMN handover_slot_id TEXT;
ALTER TABLE shipments ADD COLUMN handover_slot_start TEXT;
ALTER TABLE shipments ADD COLUMN handover_slot_end TEXT;
ALTER TABLE shipments ADD COLUMN handover_method TEXT;
ALTER TABLE shipments ADD COLUMN scheduled_package_id TEXT;
ALTER TABLE shipments ADD COLUMN label_feed_id TEXT;
ALTER TABLE shipments ADD COLUMN label_report_id TEXT;
ALTER TABLE shipments ADD COLUMN label_status TEXT NOT NULL DEFAULT 'not_requested' CHECK (
  label_status IN ('not_requested', 'feed_submitted', 'report_ready', 'document_ready', 'failed')
);

-- Admin-set list price per SKU. Shown on admin screens only — packers must
-- never see prices (explicit requirement, session 2). This is a list/MRP
-- price the admin maintains, not the actual per-order sold price (Amazon's
-- Orders API ItemPrice isn't captured yet — a future enhancement if the
-- user wants real revenue figures per order rather than list price).
ALTER TABLE skus ADD COLUMN price REAL;
