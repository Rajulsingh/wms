-- Backs rate limiting on both login endpoints (floor PIN + org owner
-- email/password) — neither had any throttling before this, making a
-- 4-digit PIN brute-forceable in seconds. One row per failed attempt;
-- pruned opportunistically on write rather than via a cron trigger (the
-- account's Workers Free plan caps cron triggers at 5 total — see
-- wrangler.jsonc — so this table self-prunes instead of needing one).
CREATE TABLE login_attempts (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  ip TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_login_attempts_identifier ON login_attempts(identifier, created_at);
CREATE INDEX idx_login_attempts_ip ON login_attempts(ip, created_at);
