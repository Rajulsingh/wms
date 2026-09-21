-- Multi-tenant onboarding (WMS becoming a paid, self-serve tool other
-- Amazon sellers can sign up for, not just the one warehouse this was built
-- for — see HANDOFF.md). Deliberately does NOT touch anything under
-- `warehouses.id` — every existing pick/pack/ship/order query stays scoped
-- by warehouse_id exactly as before; `organizations` sits one layer above
-- it, owning only: which Amazon account a warehouse's orders sync against,
-- who can sign up/log in as that seller's admin, and billing status. One
-- warehouse per organization for now (a deliberate v1 scope choice, not a
-- schema limit — nothing here stops an org from getting a second warehouse
-- later).
CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'onboarding' CHECK (status IN ('onboarding', 'active', 'suspended')),
  -- Amazon LWA credentials, entered manually during onboarding (see
  -- src/pages/onboarding/connect-amazon.astro) until this app's SP-API
  -- application is approved as Public and a one-click OAuth "Authorize"
  -- flow can replace this. Secrets are AES-GCM encrypted (lib/crypto.ts)
  -- before they ever reach a D1 row.
  amazon_client_id TEXT,
  amazon_client_secret_enc TEXT,
  amazon_refresh_token_enc TEXT,
  amazon_selling_partner_id TEXT,
  amazon_marketplace_id TEXT,
  amazon_merchant_id TEXT,
  amazon_sandbox INTEGER NOT NULL DEFAULT 0,
  amazon_connected_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The org owner's login is intentionally a *separate* mechanism from the
-- floor PIN system in auth.ts/users.pin_hash — a seller signing up for a
-- SaaS tool needs email+password (recoverable, not shared-device-friendly),
-- pickers/packers need a fast shared-device PIN. Rather than teach every
-- existing admin page/API a second session type, an org_account is a thin
-- credential wrapper around one real `users` row (role='admin', see
-- lib/org-accounts.ts) — logging in here just resolves email+password to
-- that user and creates the exact same wms_session cookie the PIN flow
-- creates, so every existing /admin page and requireUser() check keeps
-- working unmodified.
CREATE TABLE org_accounts (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  admin_user_id TEXT NOT NULL REFERENCES users(id),
  email TEXT NOT NULL UNIQUE,
  -- NULL until the owner sets a password — the state a partner-provisioned
  -- account (api/partner/provision-org.ts) starts in, since it's created
  -- without the owner present to type one.
  password_hash TEXT,
  setup_token TEXT,
  setup_token_expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE warehouses ADD COLUMN organization_id TEXT REFERENCES organizations(id);

-- Leads from the public pricing/"Purchase WMS" page (src/pages/pricing.astro)
-- — no payment processor wired up yet (deliberate v1 scope choice), so this
-- is a request queue an admin actions manually rather than an auto-provision.
CREATE TABLE access_requests (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  company TEXT,
  phone TEXT,
  message TEXT,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'onboarded', 'declined')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
