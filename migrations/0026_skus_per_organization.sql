-- Closes a real cross-tenant leak found while testing onboarding: `skus`
-- had no organization_id at all (original comment: "Product master. Shared
-- across warehouses") — fine for one seller, but with other orgs signing up
-- (migrations/0025_organizations.sql) a new seller's admin pages (SKU list,
-- inventory report, receiving dropdown) queried this table directly and got
-- back *every* seller's product catalog, not just their own.
--
-- Deliberately just an ADD COLUMN, not the usual rebuild-and-rename pattern
-- (migrations/0002_simplify_roles.sql) — D1 enforces foreign keys, and
-- inventory/order_items/pick_tasks/returns all hold a live `REFERENCES
-- skus(id)`, so DROP TABLE skus fails outright (confirmed live: "FOREIGN
-- KEY constraint failed", migration rolled back clean, nothing lost).
-- sku_code/barcode stay globally UNIQUE for now as a result — a same-string
-- SellerSKU/barcode collision across two different sellers is possible in
-- theory but rare in practice (Amazon SellerSKUs are seller-chosen, not
-- shared) — documented as a known follow-up in HANDOFF.md, not silently
-- ignored, since the actual demonstrated bug (unscoped reads) is fixed here.
--
-- Bootstrap organization carries this deploy's own pre-existing warehouse
-- and SKU catalog forward unchanged.
INSERT INTO organizations (id, name, slug, status) VALUES ('03f8b401-f826-46de-884c-84630abfb025', 'Ecomglider (Original)', 'ecomglider-original', 'active');

UPDATE warehouses SET organization_id = '03f8b401-f826-46de-884c-84630abfb025' WHERE organization_id IS NULL;

ALTER TABLE skus ADD COLUMN organization_id TEXT REFERENCES organizations(id);
UPDATE skus SET organization_id = '03f8b401-f826-46de-884c-84630abfb025' WHERE organization_id IS NULL;

CREATE INDEX idx_skus_organization ON skus(organization_id);
