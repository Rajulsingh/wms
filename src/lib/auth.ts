import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import type { User, UserRole } from './types';

/**
 * PIN-based session auth for pickers/packers — fast on a shared warehouse
 * device, no typed passwords on the floor (§11: "lightweight PIN-based
 * login"). Sessions are stateless signed cookies (HMAC over userId+expiry),
 * not a sessions table — nothing to clean up, nothing extra to query on
 * every request.
 */

const SESSION_COOKIE = 'wms_session';
const SESSION_TTL_SECONDS = 60 * 60 * 12; // one shift

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export async function hashPin(pin: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pin));
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

export async function verifyPin(pin: string, pinHash: string): Promise<boolean> {
  return (await hashPin(pin)) === pinHash;
}

function getSecret(): string {
  if (!env.SESSION_SECRET) throw new Error('SESSION_SECRET not set — check .dev.vars / wrangler secret.');
  return env.SESSION_SECRET;
}

export async function createSession(context: APIContext, userId: string): Promise<void> {
  const secret = getSecret();
  const expires = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const payload = `${userId}.${expires}`;
  const sig = await hmac(secret, payload);
  context.cookies.set(SESSION_COOKIE, `${payload}.${sig}`, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_SECONDS
  });
}

export function clearSession(context: APIContext): void {
  context.cookies.delete(SESSION_COOKIE, { path: '/' });
}

async function getSessionUserId(context: APIContext): Promise<string | null> {
  const raw = context.cookies.get(SESSION_COOKIE)?.value;
  if (!raw) return null;
  const [userId, expiresStr, sig] = raw.split('.');
  if (!userId || !expiresStr || !sig) return null;

  const secret = getSecret();
  const expected = await hmac(secret, `${userId}.${expiresStr}`);
  if (expected !== sig) return null;
  if (Number(expiresStr) < Math.floor(Date.now() / 1000)) return null;
  return userId;
}

/** Loads the current user, or null if there's no valid session. Doesn't check role. */
export async function getCurrentUser(context: APIContext, db: D1Database): Promise<User | null> {
  const userId = await getSessionUserId(context);
  if (!userId) return null;
  const user = await db.prepare(`SELECT * FROM users WHERE id = ? AND active = 1`).bind(userId).first<User>();
  return user ?? null;
}

/** For API routes: 401s if not logged in, 403s if the role isn't allowed. Admins can always act as an override authority (§6: "only a supervisor role can override a hard block" — admin fills that role now that supervisor is gone). */
export async function requireUser(context: APIContext, db: D1Database, allowedRoles?: UserRole[]): Promise<User> {
  const user = await getCurrentUser(context, db);
  if (!user) throw new AuthError(401, 'Not logged in');
  if (allowedRoles && !allowedRoles.includes(user.role) && user.role !== 'admin') {
    throw new AuthError(403, `Role "${user.role}" cannot perform this action`);
  }
  return user;
}

export class AuthError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/**
 * Verifies a client-supplied `warehouseId` actually belongs to the calling
 * session — `requireUser` only checks *role* ("is this an admin/packer"),
 * never *whose* data a warehouseId points at. Without this, any logged-in
 * user could pass a different org's warehouseId and read/modify that
 * warehouse's data outright — confirmed live: a brand-new self-signed-up
 * org's session pulled a completely different organization's real orders
 * and inventory this way, through routes that trusted the client-supplied
 * id with no ownership check at all. Every route that accepts warehouseId
 * from the client (query param, JSON body) must call this immediately
 * after requireUser, using the exact user object requireUser returned.
 */
export function requireOwnWarehouse(user: User, warehouseId: string | null | undefined): asserts warehouseId is string {
  if (!warehouseId || user.warehouse_id !== warehouseId) {
    throw new AuthError(403, 'Not authorized for this warehouse');
  }
}

/**
 * Server-side admin gate for every `src/pages/admin/*.astro` page. Returns a
 * redirect path if the request shouldn't see the page at all, or `null` if
 * it's an admin session and rendering can proceed. Every admin page must
 * call this and `return Astro.redirect(path)` itself if it gets one back —
 * the actual redirect has to happen in the page's own frontmatter, not in a
 * shared/nested component (AdminShell.astro tried that; Astro.redirect()
 * from a nested component doesn't actually redirect, confirmed live).
 * Without this, the admin sidebar/nav (Users, Settings, etc.) was rendered
 * server-side for *any* logged-in session — API routes already 403 a
 * non-admin, but the page shell itself wasn't gated, so a packer navigating
 * straight to an /admin/* URL would see the full admin nav before client-side
 * JS could react and wipe it.
 */
export async function requireAdminPage(context: APIContext, db: D1Database): Promise<string | null> {
  const user = await getCurrentUser(context, db);
  if (!user) return '/login';
  if (user.role !== 'admin') return '/picker';
  // A freshly-signed-up org owner (see org-accounts.ts) has no warehouse yet
  // — every existing admin page assumes user.warehouse_id is set, so send
  // them to finish onboarding instead of rendering a page that would 500 or
  // silently show nothing.
  if (!user.warehouse_id) return '/onboarding/warehouse';
  return null;
}

export interface ClientUser {
  id: string;
  name: string;
  role: UserRole;
  warehouseId: string | null;
  stationId: string | null;
}

/**
 * The exact shape `/api/auth/me` returns, shared so a page's own frontmatter
 * (server-side) and that endpoint (client-side) never drift apart. Used to
 * resolve the session once during the initial server render — every
 * packer/picker/dashboard page used to *only* find out who's logged in by
 * having the browser call `/api/auth/me` after the page had already loaded,
 * paying a full extra network round trip (DNS/TLS already done, but still a
 * real RTT) before it could even start fetching the page's actual data.
 * Confirmed against live production traffic (a real user on mobile data,
 * ~100ms RTT) that every individual request was fast server-side — the
 * "too slow to load" the user reported was this compounding page-load
 * waterfall, not a backend or logging performance issue. See HANDOFF.md.
 */
export function toClientUser(user: User): ClientUser {
  return { id: user.id, name: user.name, role: user.role, warehouseId: user.warehouse_id, stationId: user.station_id };
}
