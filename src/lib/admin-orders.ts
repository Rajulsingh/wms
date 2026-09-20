/**
 * Powers the admin orders page's Amazon-Seller-Central-style browsing: top
 * tabs (Pending/Unshipped/Sent/Cancelled), Sent's own Waiting-for-pickup vs
 * Shipped split, search by several fields, sorting, and pagination. Kept
 * separate from orders.ts (the pick/pack pipeline logic) since this is pure
 * read/browse — nothing here reserves stock or moves an order forward.
 *
 * The four top-level tabs are derived from Amazon's own fields
 * (`amazon_order_status`, and this app's `status` for the shipped/cancelled
 * terminal states) rather than this app's internal pick/pack status, since
 * the whole point is to mirror what the seller sees on Seller Central, not
 * our own floor-progress granularity (that's what the internal status pill
 * on each row is still for).
 */

export type AdminOrderTab = 'pending' | 'unshipped' | 'sent' | 'cancelled' | 'all';
export type SentFilter = 'waiting_pickup' | 'shipped';
export type SearchField = 'order_id' | 'asin' | 'sku' | 'product_name' | 'tracking_id' | 'buyer_name';
export type SortOption = 'ship_by_asc' | 'ship_by_desc' | 'order_date_asc' | 'order_date_desc';

export interface AdminOrdersQuery {
  tab: AdminOrderTab;
  sentFilter?: SentFilter;
  searchField?: SearchField;
  searchQuery?: string;
  sort?: SortOption;
  page: number;
  pageSize: number;
}

export interface AdminOrderRow {
  id: string;
  external_order_id: string;
  source: string;
  status: string;
  amazon_order_status: string | null;
  easyship_status: string | null;
  customer_name: string | null;
  created_at: string;
  ship_by: string | null;
  first_item_name: string | null;
  first_item_image: string | null;
  item_count: number;
  order_value: number | null;
  notes: string | null;
  tracking_id: string | null;
  display_status: string;
  display_status_style: string;
}

export interface AdminOrdersResult {
  orders: AdminOrderRow[];
  totalCount: number;
  tabCounts: Record<AdminOrderTab, number>;
  sentCounts: Record<SentFilter, number>;
}

// Reused identically in both the tab-count query and the list query so the
// two can never disagree about which bucket an order falls into. `status =
// 'shipped'` (this app's own terminal state, only set once syncOrderStatuses
// confirms the courier actually took the package — see amazon-sync.ts) is
// checked ahead of `amazon_order_status = 'Shipped'` for that reason: an
// Easy Ship order Amazon already calls "Shipped" the moment pickup is
// scheduled still belongs in "Sent" (Amazon shows it there too, just under
// "Waiting for pickup"), so either signal routes it to 'sent' — the split
// between the two happens only within the 'sent' bucket, via SENT_TAB_CASE.
const TAB_CASE = `
  CASE
    WHEN o.status = 'cancelled' OR o.amazon_order_status = 'Canceled' THEN 'cancelled'
    WHEN o.status = 'shipped' OR o.amazon_order_status = 'Shipped' THEN 'sent'
    WHEN o.amazon_order_status = 'Pending' THEN 'pending'
    ELSE 'unshipped'
  END
`;

// Within 'sent': our own `status` only reaches 'shipped' once the courier
// has actually collected the package (see amazon-sync.ts's stillWithSeller
// check) — so "not yet 'shipped' internally, but Amazon-side Sent" is
// exactly Amazon's own "Waiting for pickup" bucket, with no separate
// dependence on the exact EasyShipShipmentStatus string.
const SENT_SUB_CASE = `CASE WHEN o.status != 'shipped' THEN 'waiting_pickup' ELSE 'shipped' END`;

function searchPredicate(field: SearchField, query: string): { sql: string; params: unknown[] } {
  const like = `%${query}%`;
  switch (field) {
    case 'order_id':
      return { sql: 'o.external_order_id LIKE ?', params: [like] };
    case 'buyer_name':
      return { sql: 'o.customer_name LIKE ?', params: [like] };
    case 'asin':
      return {
        sql: `EXISTS (SELECT 1 FROM order_items oi JOIN skus s ON s.id = oi.sku_id WHERE oi.order_id = o.id AND s.asin LIKE ?)`,
        params: [like]
      };
    case 'sku':
      return {
        sql: `EXISTS (SELECT 1 FROM order_items oi JOIN skus s ON s.id = oi.sku_id WHERE oi.order_id = o.id AND s.sku_code LIKE ?)`,
        params: [like]
      };
    case 'product_name':
      return {
        sql: `EXISTS (SELECT 1 FROM order_items oi JOIN skus s ON s.id = oi.sku_id WHERE oi.order_id = o.id AND s.name LIKE ?)`,
        params: [like]
      };
    case 'tracking_id':
      return {
        sql: `EXISTS (
          SELECT 1 FROM pack_sessions ps
          JOIN packages pk ON pk.pack_session_id = ps.id
          JOIN shipments sh ON sh.package_id = pk.id
          LEFT JOIN awbs a ON a.shipment_id = sh.id
          WHERE ps.order_id = o.id AND (sh.tracking_id LIKE ? OR a.awb_code LIKE ?)
        )`,
        params: [like, like]
      };
  }
}

// `o.ship_by IS NULL` sorts first so rows missing it (only possible for
// pre-migration/manual orders) always land last regardless of direction,
// instead of NULLs floating to the top of an ascending sort by SQLite's
// default NULL-ordering.
const SORT_SQL: Record<SortOption, string> = {
  ship_by_asc: 'o.ship_by IS NULL, o.ship_by ASC',
  ship_by_desc: 'o.ship_by IS NULL, o.ship_by DESC',
  order_date_asc: 'o.created_at ASC',
  order_date_desc: 'o.created_at DESC'
};

// Mirrors Amazon's own Order Status vocabulary (Pending, Unshipped, Waiting
// for pickup, Picked up, Delivered to buyer, Shipped, Cancelled) as closely
// as this app's own signals allow. "Delivered to buyer" and "Picked up"
// only ever show up if `easyship_status` happens to already be at that value
// — see the sync-time caveat in amazon-sync.ts (it stops advancing once the
// order goes terminal here), so most genuinely-shipped orders will just say
// "Shipped" rather than tracking all the way to delivery.
function displayStatus(o: { status: string; amazon_order_status: string | null; easyship_status: string | null }): { label: string; style: string } {
  if (o.status === 'cancelled' || o.amazon_order_status === 'Canceled') return { label: 'Cancelled', style: 'status-danger' };
  if (o.status === 'shipped' || o.amazon_order_status === 'Shipped') {
    if (o.status !== 'shipped') return { label: 'Waiting for pickup', style: 'status-warning' };
    if (o.easyship_status === 'Delivered') return { label: 'Delivered to buyer', style: 'status-success' };
    if (o.easyship_status === 'PickedUp') return { label: 'Picked up', style: 'status-progress' };
    return { label: 'Shipped', style: 'status-success' };
  }
  if (o.amazon_order_status === 'Pending') return { label: 'Pending', style: 'status-neutral' };
  return { label: 'Unshipped', style: 'status-progress' };
}

export async function getAdminOrders(db: D1Database, warehouseId: string, query: AdminOrdersQuery): Promise<AdminOrdersResult> {
  const tabCountsRows = await db
    .prepare(`SELECT ${TAB_CASE} AS tab, COUNT(*) AS c FROM orders o WHERE o.warehouse_id = ? GROUP BY tab`)
    .bind(warehouseId)
    .all<{ tab: string; c: number }>();
  const tabCounts: Record<AdminOrderTab, number> = { pending: 0, unshipped: 0, sent: 0, cancelled: 0, all: 0 };
  for (const r of tabCountsRows.results) {
    tabCounts[r.tab as AdminOrderTab] = r.c;
    tabCounts.all += r.c;
  }

  const sentCountsRows = await db
    .prepare(`SELECT ${SENT_SUB_CASE} AS sub, COUNT(*) AS c FROM orders o WHERE o.warehouse_id = ? AND (${TAB_CASE}) = 'sent' GROUP BY sub`)
    .bind(warehouseId)
    .all<{ sub: string; c: number }>();
  const sentCounts: Record<SentFilter, number> = { waiting_pickup: 0, shipped: 0 };
  for (const r of sentCountsRows.results) sentCounts[r.sub as SentFilter] = r.c;

  const whereParts: string[] = ['o.warehouse_id = ?'];
  const params: unknown[] = [warehouseId];

  if (query.tab !== 'all') {
    whereParts.push(`(${TAB_CASE}) = ?`);
    params.push(query.tab);
  }
  if (query.tab === 'sent' && query.sentFilter) {
    whereParts.push(`(${SENT_SUB_CASE}) = ?`);
    params.push(query.sentFilter);
  }
  if (query.searchField && query.searchQuery?.trim()) {
    const { sql, params: searchParams } = searchPredicate(query.searchField, query.searchQuery.trim());
    whereParts.push(sql);
    params.push(...searchParams);
  }
  const whereSql = whereParts.join(' AND ');

  const countRow = await db
    .prepare(`SELECT COUNT(*) AS c FROM orders o WHERE ${whereSql}`)
    .bind(...params)
    .first<{ c: number }>();
  const totalCount = countRow?.c ?? 0;

  const sortSql = SORT_SQL[query.sort ?? 'order_date_desc'];
  const offset = (query.page - 1) * query.pageSize;
  const rows = await db
    .prepare(
      `SELECT o.id, o.external_order_id, o.source, o.status, o.amazon_order_status, o.easyship_status,
              o.customer_name, o.created_at, o.ship_by, o.notes,
              (SELECT s.name FROM order_items oi JOIN skus s ON s.id = oi.sku_id WHERE oi.order_id = o.id ORDER BY oi.id LIMIT 1) AS first_item_name,
              (SELECT s.image_url FROM order_items oi JOIN skus s ON s.id = oi.sku_id WHERE oi.order_id = o.id ORDER BY oi.id LIMIT 1) AS first_item_image,
              (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS item_count,
              (SELECT SUM(COALESCE(s.price, 0) * oi.quantity_ordered) FROM order_items oi JOIN skus s ON s.id = oi.sku_id WHERE oi.order_id = o.id) AS order_value,
              (SELECT COALESCE(sh.tracking_id, a.awb_code) FROM pack_sessions ps
                 JOIN packages pk ON pk.pack_session_id = ps.id
                 JOIN shipments sh ON sh.package_id = pk.id
                 LEFT JOIN awbs a ON a.shipment_id = sh.id
                 WHERE ps.order_id = o.id LIMIT 1) AS tracking_id
       FROM orders o
       WHERE ${whereSql}
       ORDER BY ${sortSql}
       LIMIT ? OFFSET ?`
    )
    .bind(...params, query.pageSize, offset)
    .all<Omit<AdminOrderRow, 'display_status' | 'display_status_style'>>();

  const orders: AdminOrderRow[] = rows.results.map((r) => {
    const { label, style } = displayStatus(r);
    return { ...r, display_status: label, display_status_style: style };
  });

  return { orders, totalCount, tabCounts, sentCounts };
}
