-- Demo data for local dev. Not a migration — apply manually:
--   npx wrangler d1 execute wms-db --local --file=scripts/seed.sql
-- PINs (for the login screen): admin/1234, packer/1111
-- Two roles only (migrations/0002_simplify_roles.sql): 'admin' and 'packer'
-- — 'packer' is one floor-worker role that does both picking and packing.

INSERT INTO warehouses (id, name, code) VALUES ('wh-1', 'Demo Warehouse', 'WH1');

INSERT INTO zones (id, warehouse_id, name, sequence_number) VALUES ('zone-1', 'wh-1', 'Main floor', 0);

-- Matches the original brief's example route: Rack A -> Rack C -> Rack D.
INSERT INTO locations (id, warehouse_id, zone_id, code, type, sequence_number, qr_token) VALUES
  ('loc-a', 'wh-1', 'zone-1', 'Rack A', 'pickable', 10, 'LOC-RACK-A'),
  ('loc-c', 'wh-1', 'zone-1', 'Rack C', 'pickable', 30, 'LOC-RACK-C'),
  ('loc-d', 'wh-1', 'zone-1', 'Rack D', 'pickable', 40, 'LOC-RACK-D'),
  ('loc-b', 'wh-1', 'zone-1', 'Rack B', 'pickable', 20, 'LOC-RACK-B'),
  ('loc-reserve-1', 'wh-1', 'zone-1', 'Reserve 1', 'reserve', 900, 'LOC-RESERVE-1');

INSERT INTO skus (id, sku_code, barcode, name, image_url) VALUES
  ('sku-1', 'WIDGET-RED', '0000000001', 'Red Widget', 'https://placehold.co/160x160/e11d48/ffffff?text=Red'),
  ('sku-2', 'WIDGET-BLUE', '0000000002', 'Blue Widget', 'https://placehold.co/160x160/2563eb/ffffff?text=Blue'),
  ('sku-3', 'GADGET-STD', '0000000003', 'Standard Gadget', 'https://placehold.co/160x160/64748b/ffffff?text=Gadget'),
  ('sku-4', 'GIZMO-XL', '0000000004', 'XL Gizmo', 'https://placehold.co/160x160/16a34a/ffffff?text=Gizmo');

INSERT INTO inventory (id, sku_id, location_id, quantity_on_hand, quantity_reserved) VALUES
  ('inv-1', 'sku-1', 'loc-a', 50, 0),
  ('inv-2', 'sku-2', 'loc-a', 30, 0),
  ('inv-3', 'sku-3', 'loc-c', 40, 0),
  ('inv-4', 'sku-4', 'loc-d', 20, 0),
  ('inv-5', 'sku-1', 'loc-reserve-1', 200, 0);

INSERT INTO carts (id, warehouse_id, code, slot_count) VALUES ('cart-1', 'wh-1', 'Cart 1', 8);

INSERT INTO packing_stations (id, warehouse_id, code, qr_token) VALUES ('station-1', 'wh-1', 'Station 1', 'STATION-1');

INSERT INTO users (id, warehouse_id, name, role, pin_hash) VALUES
  ('user-admin', 'wh-1', 'admin', 'admin', 'A6xnQhbz4Vx2HuGl4lXwZ5U2I8iziLRFnhP5eNfIRvQ='),
  ('user-packer', 'wh-1', 'packer', 'packer', 'D/4avRoIIVNTwjPW4AlhPpXuxCU4Mqdhryj/N6xaFQw=');

-- A demo order spanning Rack A and Rack C so the picker route has two real stops.
INSERT INTO orders (id, warehouse_id, external_order_id, source, status, customer_name) VALUES
  ('order-1', 'wh-1', 'DEMO-1001', 'manual', 'pending', 'Jane Demo');

INSERT INTO order_items (id, order_id, sku_id, quantity_ordered) VALUES
  ('oi-1', 'order-1', 'sku-1', 2),
  ('oi-2', 'order-1', 'sku-3', 1);
