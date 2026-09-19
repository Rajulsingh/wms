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
