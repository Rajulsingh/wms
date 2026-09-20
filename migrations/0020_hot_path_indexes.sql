-- Production incident, 3 days after launch: Cloudflare emailed that the D1
-- free-tier daily rows_read cap (5,000,000) was at 77% for the day. Root
-- cause was two things stacking, both fixed alongside this migration (see
-- dashboard.ts/packer.ts for the query-side half of the fix):
--
-- 1. Several "today" queries filtered with `date(col) = date('now')`, which
--    wraps the column in a function and defeats any index on it — a full
--    table scan every call. `getTodaySummary` (dashboard.ts) does this twice
--    against `audit_log`, which is append-only and grows forever, and is
--    polled every 15s by *every* logged-in session regardless of role
--    (api/dashboard/today.ts has no role restriction on purpose). That one
--    function was responsible for the large majority of the day's reads.
--    Those queries were rewritten to a plain `col >= date('now') AND col <
--    date('now', '+1 day')` range, which the indexes below make usable.
--
-- 2. `pick_batches` had no index at all beyond its primary key, despite
--    being filtered by warehouse_id/assigned_picker_id/status in several
--    polled-every-8-15s endpoints (claim-batch, packer/picker dashboards,
--    admin pick-assign's sku-demand poll). Tables are small right now (tens
--    to low hundreds of rows) so any one scan is cheap, but the query
--    volume from that much polling is not — this compounds every day as
--    order volume grows, the same way audit_log did.
CREATE INDEX idx_audit_log_action_created ON audit_log (action, created_at);
CREATE INDEX idx_pick_batches_warehouse_status ON pick_batches (warehouse_id, status);
CREATE INDEX idx_pick_batches_picker_status ON pick_batches (assigned_picker_id, status);
CREATE INDEX idx_pick_tasks_status ON pick_tasks (status);
CREATE INDEX idx_pack_sessions_packer_status ON pack_sessions (packer_id, status);
CREATE INDEX idx_order_items_sku ON order_items (sku_id);
