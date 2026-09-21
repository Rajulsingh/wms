import { newId } from './db';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function istDateString(ms = Date.now()): string {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** [startUtc, endUtc) bounds, in SQLite's own 'YYYY-MM-DD HH:MM:SS' text format, for one IST calendar day — comparable directly against occurred_at (written via datetime('now'), which D1/SQLite stores in that same UTC text format). Computed in JS rather than a SQLite date-modifier expression for the same reason the rest of this app does: an IST/UTC mismatch here silently breaks comparisons instead of erroring. */
function istDayBoundsUtc(dateStr: string): { startUtc: string; endUtc: string } {
  const startUtcMs = new Date(`${dateStr}T00:00:00.000Z`).getTime() - IST_OFFSET_MS;
  const endUtcMs = startUtcMs + 24 * 60 * 60 * 1000;
  const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  return { startUtc: fmt(startUtcMs), endUtc: fmt(endUtcMs) };
}

/**
 * Attendance is derived from the PIN login/logout every floor worker
 * already does daily (see api/auth/login.ts and api/auth/logout.ts) — no
 * separate clock-in action. This is insert-only and best-effort: it never
 * throws, so a logging failure can never block an actual login.
 */
export async function recordAttendanceEvent(db: D1Database, userId: string, warehouseId: string, eventType: 'login' | 'logout'): Promise<void> {
  try {
    await db
      .prepare(`INSERT INTO staff_attendance_events (id, user_id, warehouse_id, event_type, occurred_at) VALUES (?, ?, ?, ?, datetime('now'))`)
      .bind(newId(), userId, warehouseId, eventType)
      .run();
  } catch (err) {
    console.error(`recordAttendanceEvent failed for user ${userId}:`, err);
  }
}

export interface TodayAttendanceRow {
  userId: string;
  name: string;
  role: string;
  checkInAt: string | null;
  checkOutAt: string | null;
  present: boolean;
}

/** Every active packer in the warehouse, whether or not they've logged in today — the point of an attendance view is showing who HASN'T shown up too, not just who has. */
export async function getTodayAttendance(db: D1Database, warehouseId: string): Promise<TodayAttendanceRow[]> {
  const { startUtc, endUtc } = istDayBoundsUtc(istDateString());
  const rows = await db
    .prepare(
      `SELECT u.id AS userId, u.name, u.role,
              MIN(CASE WHEN e.event_type = 'login' THEN e.occurred_at END) AS checkInAt,
              MAX(CASE WHEN e.event_type = 'login' THEN e.occurred_at END) AS lastLoginAt,
              MAX(CASE WHEN e.event_type = 'logout' THEN e.occurred_at END) AS checkOutAt
       FROM users u
       LEFT JOIN staff_attendance_events e ON e.user_id = u.id AND e.occurred_at >= ? AND e.occurred_at < ?
       WHERE u.warehouse_id = ? AND u.role = 'packer' AND u.active = 1
       GROUP BY u.id, u.name, u.role
       ORDER BY u.name`
    )
    .bind(startUtc, endUtc, warehouseId)
    .all<{ userId: string; name: string; role: string; checkInAt: string | null; lastLoginAt: string | null; checkOutAt: string | null }>();

  return rows.results.map((r) => ({
    userId: r.userId,
    name: r.name,
    role: r.role,
    checkInAt: r.checkInAt,
    checkOutAt: r.checkOutAt,
    // "Still on the floor" — most recent login today has no logout after it.
    present: !!r.lastLoginAt && (!r.checkOutAt || r.checkOutAt < r.lastLoginAt)
  }));
}

export interface AttendanceHistoryRow {
  userId: string;
  name: string;
  workDate: string;
  checkInAt: string;
  checkOutAt: string | null;
  sessions: number;
}

/** Daily summary (check-in, check-out, session count) per staff member for the last `days` days, oldest last. */
export async function getAttendanceHistory(db: D1Database, warehouseId: string, days = 14): Promise<AttendanceHistoryRow[]> {
  const since = istDayBoundsUtc(istDateString(Date.now() - (days - 1) * 24 * 60 * 60 * 1000)).startUtc;
  const rows = await db
    .prepare(
      `SELECT u.id AS userId, u.name,
              date(e.occurred_at, '+330 minutes') AS workDate,
              MIN(CASE WHEN e.event_type = 'login' THEN e.occurred_at END) AS checkInAt,
              MAX(CASE WHEN e.event_type = 'logout' THEN e.occurred_at END) AS checkOutAt,
              SUM(CASE WHEN e.event_type = 'login' THEN 1 ELSE 0 END) AS sessions
       FROM staff_attendance_events e
       JOIN users u ON u.id = e.user_id
       WHERE e.warehouse_id = ? AND u.role = 'packer' AND e.occurred_at >= ?
       GROUP BY u.id, u.name, workDate
       HAVING checkInAt IS NOT NULL
       ORDER BY workDate DESC, u.name`
    )
    .bind(warehouseId, since)
    .all<AttendanceHistoryRow>();
  return rows.results;
}
