-- Collapse picker/packer/supervisor/dispatcher into two roles: 'admin' and
-- 'packer' (one floor-worker role that does both picking and packing — a
-- small warehouse doesn't need the distinction, and the picker/packer UI
-- split stays as two screens, just no longer gated by two different roles).
-- SQLite can't ALTER a CHECK constraint in place, so the table is rebuilt.

CREATE TABLE users_new (
  id TEXT PRIMARY KEY,
  warehouse_id TEXT REFERENCES warehouses(id),
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'packer')),
  pin_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO users_new (id, warehouse_id, name, role, pin_hash, active, created_at)
SELECT id, warehouse_id, name,
       CASE WHEN role = 'admin' THEN 'admin' ELSE 'packer' END,
       pin_hash, active, created_at
FROM users;

DROP TABLE users;
ALTER TABLE users_new RENAME TO users;
