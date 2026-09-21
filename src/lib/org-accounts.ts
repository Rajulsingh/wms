import type { AmazonEnv } from './amazon';
import { decryptSecret, encryptSecret, hashPassword, randomToken, verifyPassword } from './crypto';
import { hashPin } from './auth';

export interface Organization {
  id: string;
  name: string;
  slug: string;
  status: 'onboarding' | 'active' | 'suspended';
  amazon_client_id: string | null;
  amazon_client_secret_enc: string | null;
  amazon_refresh_token_enc: string | null;
  amazon_selling_partner_id: string | null;
  amazon_marketplace_id: string | null;
  amazon_merchant_id: string | null;
  amazon_sandbox: number;
  amazon_connected_at: string | null;
  created_at: string;
}

export interface OrgAccount {
  id: string;
  organization_id: string;
  admin_user_id: string;
  email: string;
  password_hash: string | null;
  setup_token: string | null;
  setup_token_expires_at: string | null;
  created_at: string;
}

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'org';
}

async function uniqueSlug(db: D1Database, name: string): Promise<string> {
  const base = slugify(name);
  let candidate = base;
  let n = 1;
  while (await db.prepare(`SELECT 1 FROM organizations WHERE slug = ?`).bind(candidate).first()) {
    n += 1;
    candidate = `${base}-${n}`;
  }
  return candidate;
}

export class SignupError extends Error {}

/**
 * Creates an organization, a linked `users` admin row, and the org_account
 * login wrapper around it — see migrations/0025_organizations.sql for why
 * the login is a thin wrapper rather than its own session system. No
 * warehouse yet (the caller lands on /onboarding/warehouse next); no
 * password yet if `password` is omitted (the partner-provisioning path —
 * see api/partner/provision-org.ts), in which case a setup token is issued
 * instead so the owner can set their own password via a link.
 */
export async function createOrganizationSignup(
  db: D1Database,
  params: { orgName: string; ownerName: string; email: string; password?: string }
): Promise<{ organization: Organization; orgAccount: OrgAccount; adminUserId: string; setupToken: string | null }> {
  const email = params.email.trim().toLowerCase();
  const existing = await db.prepare(`SELECT 1 FROM org_accounts WHERE email = ?`).bind(email).first();
  if (existing) throw new SignupError('An account with that email already exists');

  const orgId = crypto.randomUUID();
  const slug = await uniqueSlug(db, params.orgName);
  const adminUserId = crypto.randomUUID();
  const orgAccountId = crypto.randomUUID();

  // Floor PIN auth (auth.ts) and org owner auth are deliberately separate
  // mechanisms — this user row's pin_hash is never used for login, just
  // satisfying the NOT NULL column; a real PIN can be set later from
  // /admin/users if this owner ever wants to also log in on the floor.
  const unusablePinHash = await hashPin(crypto.randomUUID());

  let passwordHash: string | null = null;
  let setupToken: string | null = null;
  let setupTokenExpiresAt: string | null = null;
  if (params.password) {
    passwordHash = await hashPassword(params.password);
  } else {
    setupToken = randomToken();
    setupTokenExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  }

  await db.batch([
    db.prepare(`INSERT INTO organizations (id, name, slug, status) VALUES (?, ?, ?, 'onboarding')`).bind(orgId, params.orgName, slug),
    db
      .prepare(`INSERT INTO users (id, warehouse_id, name, role, pin_hash, active) VALUES (?, NULL, ?, 'admin', ?, 1)`)
      .bind(adminUserId, params.ownerName, unusablePinHash),
    db
      .prepare(
        `INSERT INTO org_accounts (id, organization_id, admin_user_id, email, password_hash, setup_token, setup_token_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(orgAccountId, orgId, adminUserId, email, passwordHash, setupToken, setupTokenExpiresAt)
  ]);

  const organization = await db.prepare(`SELECT * FROM organizations WHERE id = ?`).bind(orgId).first<Organization>();
  const orgAccount = await db.prepare(`SELECT * FROM org_accounts WHERE id = ?`).bind(orgAccountId).first<OrgAccount>();
  return { organization: organization!, orgAccount: orgAccount!, adminUserId, setupToken };
}

/** Verifies email+password and returns the linked users.id to open a normal wms_session for, or null. */
export async function verifyOrgLogin(db: D1Database, email: string, password: string): Promise<string | null> {
  const account = await db
    .prepare(`SELECT * FROM org_accounts WHERE email = ?`)
    .bind(email.trim().toLowerCase())
    .first<OrgAccount>();
  if (!account || !account.password_hash) return null;
  const ok = await verifyPassword(password, account.password_hash);
  return ok ? account.admin_user_id : null;
}

export class SetupTokenError extends Error {}

/** Resolves a still-valid setup token to its org_account, without consuming it. */
export async function getAccountBySetupToken(db: D1Database, token: string): Promise<OrgAccount | null> {
  const account = await db.prepare(`SELECT * FROM org_accounts WHERE setup_token = ?`).bind(token).first<OrgAccount>();
  if (!account || !account.setup_token_expires_at) return null;
  if (new Date(account.setup_token_expires_at) < new Date()) return null;
  return account;
}

/** Sets a password from a valid setup token (partner-provisioned accounts) and consumes the token. */
export async function setPasswordFromSetupToken(db: D1Database, token: string, password: string): Promise<string> {
  const account = await getAccountBySetupToken(db, token);
  if (!account) throw new SetupTokenError('This setup link is invalid or has expired');
  const passwordHash = await hashPassword(password);
  await db
    .prepare(`UPDATE org_accounts SET password_hash = ?, setup_token = NULL, setup_token_expires_at = NULL WHERE id = ?`)
    .bind(passwordHash, account.id)
    .run();
  return account.admin_user_id;
}

export async function getOrganizationForUser(db: D1Database, userId: string): Promise<Organization | null> {
  return db
    .prepare(
      `SELECT o.* FROM organizations o JOIN org_accounts a ON a.organization_id = o.id WHERE a.admin_user_id = ?`
    )
    .bind(userId)
    .first<Organization>();
}

export async function getOrganizationForWarehouse(db: D1Database, warehouseId: string): Promise<Organization | null> {
  return db
    .prepare(`SELECT o.* FROM organizations o JOIN warehouses w ON w.organization_id = o.id WHERE w.id = ?`)
    .bind(warehouseId)
    .first<Organization>();
}

/**
 * Creates the org's one warehouse (see migrations/0025_organizations.sql —
 * one warehouse per org is a v1 scope choice) and attaches the owner's
 * admin user to it. Safe to call only once per org; callers gate on
 * `organization.status === 'onboarding'` / the admin user having no
 * warehouse yet.
 */
export async function createOrganizationWarehouse(
  db: D1Database,
  organizationId: string,
  adminUserId: string,
  params: { name: string; code: string }
): Promise<string> {
  const warehouseId = crypto.randomUUID();
  await db.batch([
    db.prepare(`INSERT INTO warehouses (id, name, code, organization_id) VALUES (?, ?, ?, ?)`).bind(warehouseId, params.name, params.code, organizationId),
    db.prepare(`UPDATE users SET warehouse_id = ? WHERE id = ?`).bind(warehouseId, adminUserId),
    db.prepare(`UPDATE organizations SET status = 'active' WHERE id = ?`).bind(organizationId)
  ]);
  return warehouseId;
}

export async function saveAmazonCredentials(
  db: D1Database,
  organizationId: string,
  creds: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
    marketplaceId: string;
    merchantId?: string;
    sandbox?: boolean;
  }
): Promise<void> {
  const [clientSecretEnc, refreshTokenEnc] = await Promise.all([encryptSecret(creds.clientSecret), encryptSecret(creds.refreshToken)]);
  await db
    .prepare(
      `UPDATE organizations SET amazon_client_id = ?, amazon_client_secret_enc = ?, amazon_refresh_token_enc = ?, amazon_marketplace_id = ?, amazon_merchant_id = ?, amazon_sandbox = ?, amazon_connected_at = datetime('now') WHERE id = ?`
    )
    .bind(creds.clientId, clientSecretEnc, refreshTokenEnc, creds.marketplaceId, creds.merchantId ?? null, creds.sandbox ? 1 : 0, organizationId)
    .run();
}

/**
 * Resolves an organization's own Amazon credentials for lib/amazon.ts calls.
 * Returns undefined (meaning "fall back to this deploy's global env vars —
 * see getEnv() in amazon.ts) when the org hasn't connected an account yet,
 * which is exactly the state your own original warehouse is in until it's
 * explicitly backfilled — so this never breaks pre-existing behavior.
 */
export async function resolveAmazonCredentials(db: D1Database, organizationId: string | null): Promise<Partial<AmazonEnv> | undefined> {
  if (!organizationId) return undefined;
  const org = await db.prepare(`SELECT * FROM organizations WHERE id = ?`).bind(organizationId).first<Organization>();
  if (!org || !org.amazon_refresh_token_enc || !org.amazon_client_secret_enc || !org.amazon_client_id || !org.amazon_marketplace_id) {
    return undefined;
  }
  const [clientSecret, refreshToken] = await Promise.all([decryptSecret(org.amazon_client_secret_enc), decryptSecret(org.amazon_refresh_token_enc)]);
  return {
    AMAZON_LWA_CLIENT_ID: org.amazon_client_id,
    AMAZON_LWA_CLIENT_SECRET: clientSecret,
    AMAZON_REFRESH_TOKEN: refreshToken,
    AMAZON_MARKETPLACE_ID: org.amazon_marketplace_id,
    AMAZON_MERCHANT_ID: org.amazon_merchant_id ?? undefined,
    AMAZON_SPAPI_SANDBOX: org.amazon_sandbox ? 'true' : undefined
  };
}

/** Same as resolveAmazonCredentials, but looked up by warehouse — the shape every admin API route actually has in hand. */
export async function resolveAmazonCredentialsForWarehouse(db: D1Database, warehouseId: string): Promise<Partial<AmazonEnv> | undefined> {
  const row = await db.prepare(`SELECT organization_id FROM warehouses WHERE id = ?`).bind(warehouseId).first<{ organization_id: string | null }>();
  return resolveAmazonCredentials(db, row?.organization_id ?? null);
}

/**
 * Resolves a warehouse to its owning organization — every `skus` query must
 * scope by this (migrations/0026_skus_per_organization.sql: skus used to
 * have no organization_id at all, so a new seller's admin pages showed
 * every other seller's product catalog). Throws rather than silently
 * falling back to some default, since a SKU query with no organization
 * scope at all is exactly the bug this exists to prevent — every warehouse
 * has had a concrete organization_id since that migration backfilled one
 * for this deploy's own original warehouse.
 */
export async function getOrganizationIdForWarehouse(db: D1Database, warehouseId: string): Promise<string> {
  const row = await db.prepare(`SELECT organization_id FROM warehouses WHERE id = ?`).bind(warehouseId).first<{ organization_id: string | null }>();
  if (!row?.organization_id) throw new Error(`Warehouse ${warehouseId} has no organization_id — cannot scope SKU access`);
  return row.organization_id;
}
