-- Initial WMS schema (MVP scope, §11 of the WMS V2 Workflow Proposal doc).
-- warehouse_id is present on every warehouse-scoped table even though the MVP
-- runs a single warehouse, so multi-warehouse doesn't require a schema migration later.
-- IDs are app-generated UUIDs (crypto.randomUUID()), not SQLite autoincrement.

CREATE TABLE warehouses (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  warehouse_id TEXT REFERENCES warehouses(id),
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'supervisor', 'picker', 'packer', 'dispatcher')),
  pin_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE zones (
  id TEXT PRIMARY KEY,
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
  name TEXT NOT NULL,
  sequence_number INTEGER NOT NULL DEFAULT 0
);

-- A rack/shelf/bin. `qr_token` is the opaque value encoded in the printed
-- location label (scanned in place of an NFC tap — see §4/§8 of the doc).
CREATE TABLE locations (
  id TEXT PRIMARY KEY,
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
  zone_id TEXT REFERENCES zones(id),
  code TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('pickable', 'reserve')) DEFAULT 'pickable',
  sequence_number INTEGER NOT NULL DEFAULT 0,
  qr_token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (warehouse_id, code)
);
CREATE INDEX idx_locations_warehouse_sequence ON locations (warehouse_id, sequence_number);

-- Product master. Shared across warehouses; per-warehouse stock lives in `inventory`.
CREATE TABLE skus (
  id TEXT PRIMARY KEY,
  sku_code TEXT NOT NULL UNIQUE,
  barcode TEXT UNIQUE,
  name TEXT NOT NULL,
  fragile INTEGER NOT NULL DEFAULT 0,
  oversized INTEGER NOT NULL DEFAULT 0,
  hazmat INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Many-to-many SKU <-> Location, so a SKU can live in more than one bin and a
-- bin can hold more than one SKU (§7). `version` backs optimistic-concurrency
-- reservation claims so two pick batches can't lock the same units (§5, §9).
CREATE TABLE inventory (
  id TEXT PRIMARY KEY,
  sku_id TEXT NOT NULL REFERENCES skus(id),
  location_id TEXT NOT NULL REFERENCES locations(id),
  quantity_on_hand INTEGER NOT NULL DEFAULT 0,
  quantity_reserved INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('available', 'damaged', 'quarantine')) DEFAULT 'available',
  lot_code TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (sku_id, location_id)
);
CREATE INDEX idx_inventory_sku ON inventory (sku_id);
CREATE INDEX idx_inventory_location ON inventory (location_id);

CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
  external_order_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('amazon', 'manual', 'csv')) DEFAULT 'manual',
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'allocated', 'batched', 'picking', 'picked', 'packing', 'packed', 'ready_to_ship', 'shipped', 'cancelled', 'partial')
  ) DEFAULT 'pending',
  priority INTEGER NOT NULL DEFAULT 0,
  ship_by TEXT,
  customer_name TEXT,
  shipping_address TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (warehouse_id, source, external_order_id)
);
CREATE INDEX idx_orders_warehouse_status ON orders (warehouse_id, status);

CREATE TABLE order_items (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  sku_id TEXT NOT NULL REFERENCES skus(id),
  quantity_ordered INTEGER NOT NULL,
  quantity_picked INTEGER NOT NULL DEFAULT 0,
  quantity_packed INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'allocated', 'short', 'picked', 'packed', 'cancelled')
  ) DEFAULT 'pending'
);
CREATE INDEX idx_order_items_order ON order_items (order_id);

-- A wave groups orders released together (§5). The MVP runs one continuous
-- default wave; scheduled/cutoff-based waves are a later activation, not a
-- schema change.
CREATE TABLE waves (
  id TEXT PRIMARY KEY,
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
  status TEXT NOT NULL CHECK (status IN ('open', 'released', 'closed')) DEFAULT 'open',
  released_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE carts (
  id TEXT PRIMARY KEY,
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
  code TEXT NOT NULL,
  slot_count INTEGER NOT NULL DEFAULT 8,
  active INTEGER NOT NULL DEFAULT 1
);

-- A slot is bound to one order for the life of a batch, so packing knows
-- which picked item belongs to which order without re-sorting (§7).
CREATE TABLE cart_slots (
  id TEXT PRIMARY KEY,
  cart_id TEXT NOT NULL REFERENCES carts(id),
  slot_number INTEGER NOT NULL,
  order_id TEXT REFERENCES orders(id),
  UNIQUE (cart_id, slot_number)
);

CREATE TABLE pick_batches (
  id TEXT PRIMARY KEY,
  wave_id TEXT REFERENCES waves(id),
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
  cart_id TEXT REFERENCES carts(id),
  assigned_picker_id TEXT REFERENCES users(id),
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'assigned', 'in_progress', 'completed', 'cancelled')
  ) DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

-- One row per SKU x location needed within a batch. `sequence_number` is
-- denormalized from `locations` so the picker's route is a cheap sort, not a
-- per-request pathfinding calculation (§5).
CREATE TABLE pick_tasks (
  id TEXT PRIMARY KEY,
  pick_batch_id TEXT NOT NULL REFERENCES pick_batches(id),
  order_item_id TEXT NOT NULL REFERENCES order_items(id),
  sku_id TEXT NOT NULL REFERENCES skus(id),
  location_id TEXT NOT NULL REFERENCES locations(id),
  cart_slot_id TEXT REFERENCES cart_slots(id),
  quantity_required INTEGER NOT NULL,
  quantity_picked INTEGER NOT NULL DEFAULT 0,
  sequence_number INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'location_confirmed', 'picked', 'short', 'damaged', 'cancelled')
  ) DEFAULT 'pending',
  picked_at TEXT
);
CREATE INDEX idx_pick_tasks_batch_sequence ON pick_tasks (pick_batch_id, sequence_number);

CREATE TABLE packing_stations (
  id TEXT PRIMARY KEY,
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
  code TEXT NOT NULL,
  qr_token TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE pack_sessions (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  packer_id TEXT REFERENCES users(id),
  station_id TEXT REFERENCES packing_stations(id),
  status TEXT NOT NULL CHECK (
    status IN ('in_progress', 'completed', 'partial', 'cancelled')
  ) DEFAULT 'in_progress',
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

-- One order can span multiple packages (split/partial shipment) — this is
-- why Package sits between Order and Shipment rather than collapsing them (§7).
CREATE TABLE packages (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  pack_session_id TEXT REFERENCES pack_sessions(id),
  status TEXT NOT NULL CHECK (status IN ('packed', 'labeled', 'shipped', 'cancelled')) DEFAULT 'packed',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE shipments (
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL REFERENCES packages(id),
  carrier TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('label_applied', 'ready_to_ship', 'dispatched', 'failed', 'cancelled')
  ) DEFAULT 'label_applied',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- AWB is 1:1 with a shipment and globally unique, which is what enforces the
-- duplicate-scan safeguard from §6.
CREATE TABLE awbs (
  id TEXT PRIMARY KEY,
  shipment_id TEXT NOT NULL UNIQUE REFERENCES shipments(id),
  awb_code TEXT NOT NULL UNIQUE,
  scanned_at TEXT,
  verified INTEGER NOT NULL DEFAULT 0
);

-- Every short pick, damage report, mis-scan, or override — the backbone of
-- the §6 safeguards and the audit trail.
CREATE TABLE exception_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (
    type IN ('short_pick', 'damaged', 'wrong_location', 'wrong_sku_scan', 'wrong_qty', 'pack_mismatch', 'awb_mismatch', 'duplicate_awb', 'order_cancelled', 'substitution', 'other')
  ),
  pick_task_id TEXT REFERENCES pick_tasks(id),
  pack_session_id TEXT REFERENCES pack_sessions(id),
  order_id TEXT REFERENCES orders(id),
  user_id TEXT REFERENCES users(id),
  notes TEXT,
  resolved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_exception_events_order ON exception_events (order_id);

-- Append-only. Every scan and state change, regardless of outcome.
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_audit_log_entity ON audit_log (entity_type, entity_id);

-- Stubbed per §11 — not a working returns flow yet, just a place for the
-- data to land so it isn't bolted on later.
CREATE TABLE returns (
  id TEXT PRIMARY KEY,
  order_item_id TEXT NOT NULL REFERENCES order_items(id),
  sku_id TEXT NOT NULL REFERENCES skus(id),
  quantity INTEGER NOT NULL,
  condition TEXT CHECK (condition IN ('sellable', 'damaged', 'quarantine')),
  status TEXT NOT NULL CHECK (
    status IN ('received', 'graded', 'restocked', 'quarantined')
  ) DEFAULT 'received',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
