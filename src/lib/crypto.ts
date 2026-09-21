import { env } from 'cloudflare:workers';

/**
 * Two unrelated secrets, kept in one file because both are Web Crypto over
 * the same Workers runtime: (1) AES-GCM for Amazon refresh tokens/client
 * secrets stored per-organization in D1 (plaintext-at-rest wasn't
 * acceptable once these belong to sellers who aren't you), and (2) PBKDF2
 * for org owner login passwords (separate from the floor PIN system in
 * auth.ts — see org-accounts.ts for why that split is deliberate).
 */

function b64encode(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return btoa(String.fromCharCode(...arr));
}

function b64decode(str: string): Uint8Array {
  return new Uint8Array(
    atob(str)
      .split('')
      .map((c) => c.charCodeAt(0))
  );
}

async function getEncryptionKey(): Promise<CryptoKey> {
  if (!env.CREDENTIALS_ENCRYPTION_KEY) {
    throw new Error('CREDENTIALS_ENCRYPTION_KEY not set — generate one with `openssl rand -base64 32` and set it via wrangler secret / .dev.vars.');
  }
  const rawKey = b64decode(env.CREDENTIALS_ENCRYPTION_KEY);
  return crypto.subtle.importKey('raw', rawKey as BufferSource, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** Encrypts a secret (Amazon refresh token, client secret) for storage in D1. Format: `<iv>.<ciphertext>`, both base64. */
export async function encryptSecret(plaintext: string): Promise<string> {
  const key = await getEncryptionKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
  return `${b64encode(iv)}.${b64encode(ciphertext)}`;
}

export async function decryptSecret(encoded: string): Promise<string> {
  const [ivB64, ciphertextB64] = encoded.split('.');
  if (!ivB64 || !ciphertextB64) throw new Error('Malformed encrypted secret');
  const key = await getEncryptionKey();
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64decode(ivB64) as BufferSource },
    key,
    b64decode(ciphertextB64) as BufferSource
  );
  return new TextDecoder().decode(plaintext);
}

const PBKDF2_ITERATIONS = 100_000;

/** Hashes an org owner's login password. Format: `<salt>.<hash>`, both base64. Not used for floor PINs — see hashPin/verifyPin in auth.ts. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt);
  return `${b64encode(salt)}.${b64encode(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltB64, hashB64] = stored.split('.');
  if (!saltB64 || !hashB64) return false;
  const salt = b64decode(saltB64);
  const expected = b64decode(hashB64);
  const actual = await pbkdf2(password, salt);
  if (actual.length !== expected.length) return false;
  // Constant-time compare — this guards a login endpoint.
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}

async function pbkdf2(password: string, salt: Uint8Array): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  return new Uint8Array(bits);
}

/** A random, URL-safe token for onboarding-link / password-setup flows (org-accounts.ts). */
export function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return b64encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Constant-time string compare — for the partner API key (api/partner/provision-org.ts), not password hashes (those go through verifyPassword's own PBKDF2 compare). */
export function timingSafeEqual(a: string, b: string): boolean {
  const bufA = new TextEncoder().encode(a);
  const bufB = new TextEncoder().encode(b);
  if (bufA.length !== bufB.length) return false;
  let diff = 0;
  for (let i = 0; i < bufA.length; i++) diff |= bufA[i] ^ bufB[i];
  return diff === 0;
}
