// Mirrors migrations/0001_init_schema.sql. Kept as plain types (not an ORM)
// so the SQL in migrations/ stays the single source of truth for the schema.

// Two roles only: 'admin' (back office) and 'packer' (floor worker — does
// both picking and packing; see migrations/0002_simplify_roles.sql).
export type UserRole = 'admin' | 'packer';

export interface User {
  id: string;
  warehouse_id: string | null;
  name: string;
  role: UserRole;
  pin_hash: string;
  active: number;
  station_id: string | null;
  created_at: string;
}

export interface Warehouse {
  id: string;
  name: string;
  code: string;
  created_at: string;
}

export interface Location {
  id: string;
  warehouse_id: string;
  zone_id: string | null;
  code: string;
  type: 'pickable' | 'reserve';
  sequence_number: number;
  qr_token: string;
  created_at: string;
}

export interface Sku {
  id: string;
  sku_code: string;
  barcode: string | null;
  name: string;
  image_url: string | null;
  fragile: number;
  oversized: number;
  hazmat: number;
  created_at: string;
}

export interface InventoryRow {
  id: string;
  sku_id: string;
  location_id: string;
  quantity_on_hand: number;
  quantity_reserved: number;
  status: 'available' | 'damaged' | 'quarantine';
  lot_code: string | null;
  version: number;
  updated_at: string;
}

export type OrderStatus =
  | 'pending'
  | 'allocated'
  | 'batched'
  | 'picking'
  | 'picked'
  | 'packing'
  | 'packed'
  | 'ready_to_ship'
  | 'shipped'
  | 'cancelled'
  | 'partial';

export interface Order {
  id: string;
  warehouse_id: string;
  external_order_id: string;
  source: 'amazon' | 'manual' | 'csv';
  status: OrderStatus;
  priority: number;
  ship_by: string | null;
  customer_name: string | null;
  shipping_address: string | null;
  created_at: string;
}

export interface OrderItem {
  id: string;
  order_id: string;
  sku_id: string;
  quantity_ordered: number;
  quantity_picked: number;
  quantity_packed: number;
  status: 'pending' | 'allocated' | 'short' | 'picked' | 'packed' | 'cancelled';
  amazon_order_item_id: string | null;
}

export interface PickBatch {
  id: string;
  wave_id: string | null;
  warehouse_id: string;
  cart_id: string | null;
  assigned_picker_id: string | null;
  status: 'pending' | 'assigned' | 'in_progress' | 'completed' | 'cancelled';
  created_at: string;
  completed_at: string | null;
}

export interface PickTask {
  id: string;
  pick_batch_id: string;
  order_item_id: string;
  sku_id: string;
  location_id: string;
  cart_slot_id: string | null;
  quantity_required: number;
  quantity_picked: number;
  sequence_number: number;
  status: 'pending' | 'location_confirmed' | 'picked' | 'short' | 'damaged' | 'cancelled';
  picked_at: string | null;
}

// Joined shape the picker UI actually consumes for one task.
export interface PickTaskView extends PickTask {
  sku_code: string;
  sku_name: string;
  barcode: string | null;
  image_url: string | null;
  location_code: string;
  location_qr_token: string;
}

export type ExceptionType =
  | 'short_pick'
  | 'damaged'
  | 'wrong_location'
  | 'wrong_sku_scan'
  | 'wrong_qty'
  | 'pack_mismatch'
  | 'awb_mismatch'
  | 'duplicate_awb'
  | 'order_cancelled'
  | 'substitution'
  | 'other';
