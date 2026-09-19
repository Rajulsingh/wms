-- Support for purchasing real Amazon shipping labels via the Merchant
-- Fulfillment API (getEligibleShippingServices + createShipment), which
-- needs: a ship-from address per warehouse, a box-size preset to pick from
-- per order, the Amazon-side OrderItemId (distinct from our own order_item
-- id), and somewhere to store the purchased label + tracking id.

ALTER TABLE warehouses ADD COLUMN ship_from_name TEXT;
ALTER TABLE warehouses ADD COLUMN ship_from_address_line1 TEXT;
ALTER TABLE warehouses ADD COLUMN ship_from_city TEXT;
ALTER TABLE warehouses ADD COLUMN ship_from_state TEXT;
ALTER TABLE warehouses ADD COLUMN ship_from_postal_code TEXT;
ALTER TABLE warehouses ADD COLUMN ship_from_country_code TEXT;
ALTER TABLE warehouses ADD COLUMN ship_from_phone TEXT;
ALTER TABLE warehouses ADD COLUMN ship_from_email TEXT;

-- Amazon's own item identifier for this order line — required by the
-- Merchant Fulfillment API's ItemList, distinct from our own order_items.id.
ALTER TABLE order_items ADD COLUMN amazon_order_item_id TEXT;

CREATE TABLE box_sizes (
  id TEXT PRIMARY KEY,
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
  name TEXT NOT NULL,
  length REAL NOT NULL,
  width REAL NOT NULL,
  height REAL NOT NULL,
  dimension_unit TEXT NOT NULL DEFAULT 'centimeters',
  active INTEGER NOT NULL DEFAULT 1
);

ALTER TABLE packages ADD COLUMN box_size_id TEXT REFERENCES box_sizes(id);
ALTER TABLE packages ADD COLUMN weight_value REAL;
ALTER TABLE packages ADD COLUMN weight_unit TEXT DEFAULT 'grams';

ALTER TABLE shipments ADD COLUMN carrier_service_id TEXT;
ALTER TABLE shipments ADD COLUMN carrier_service_name TEXT;
ALTER TABLE shipments ADD COLUMN rate_amount REAL;
ALTER TABLE shipments ADD COLUMN rate_currency TEXT;
ALTER TABLE shipments ADD COLUMN amazon_shipment_id TEXT;
ALTER TABLE shipments ADD COLUMN tracking_id TEXT;
-- Base64 label image straight from Amazon's response, plus its declared file type (e.g. image/png) — no separate download/fetch step needed.
ALTER TABLE shipments ADD COLUMN label_base64 TEXT;
ALTER TABLE shipments ADD COLUMN label_file_type TEXT;
