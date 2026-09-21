-- Attendance derived from the PIN login every floor worker already does
-- every day (see api/auth/login.ts) — no separate clock-in action, just a
-- record of when that login/logout actually happened. One row per event
-- rather than one row per day-per-user: a day's check-in/check-out/session
-- count are all derived by querying this log (see lib/attendance.ts), which
-- keeps this insert-only and side-effect-free from the login/logout routes'
-- own perspective — nothing here can block or fail a login.
CREATE TABLE staff_attendance_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('login', 'logout')),
  occurred_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_attendance_events_user ON staff_attendance_events (user_id, occurred_at);
CREATE INDEX idx_attendance_events_warehouse ON staff_attendance_events (warehouse_id, occurred_at);
