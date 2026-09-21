-- Adds a distinct exception type for a real incident (see HANDOFF.md):
-- Amazon reporting an order Shipped/PickedUp while this WMS still had open
-- pick_tasks for it (a backlog import whose units had already left through
-- some channel outside normal pick/pack). Reusing 'order_cancelled' for
-- this would mislead an admin triaging exceptions — nothing was cancelled,
-- the order shipped fine; it's the *tracking* that needs a look.
-- SQLite can't ALTER a CHECK constraint in place, so the table is rebuilt —
-- same pattern as migrations/0002_simplify_roles.sql. Nothing references
-- exception_events as a foreign key parent, so this rebuild is safe.
CREATE TABLE exception_events_new (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (
    type IN ('short_pick', 'damaged', 'wrong_location', 'wrong_sku_scan', 'wrong_qty', 'pack_mismatch', 'awb_mismatch', 'duplicate_awb', 'order_cancelled', 'substitution', 'shipped_before_picked', 'other')
  ),
  pick_task_id TEXT REFERENCES pick_tasks(id),
  pack_session_id TEXT REFERENCES pack_sessions(id),
  order_id TEXT REFERENCES orders(id),
  user_id TEXT REFERENCES users(id),
  notes TEXT,
  resolved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO exception_events_new SELECT * FROM exception_events;

DROP TABLE exception_events;
ALTER TABLE exception_events_new RENAME TO exception_events;
CREATE INDEX idx_exception_events_order ON exception_events (order_id);
