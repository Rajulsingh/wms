import { env } from 'cloudflare:workers';
import type { ExceptionType } from './types';

/**
 * Pulls the D1 binding straight from the Worker's own environment.
 * `Astro.locals.runtime.env` was removed in Astro v6 — `cloudflare:workers`
 * is the current way to reach bindings from anywhere in server-side code,
 * dev and deployed alike.
 */
export function getDb(): D1Database {
  if (!env.DB) {
    throw new Error('D1 binding "DB" not found — check wrangler.jsonc.');
  }
  return env.DB;
}

export function newId(): string {
  return crypto.randomUUID();
}

export async function logAudit(
  db: D1Database,
  entry: { userId: string | null; action: string; entityType?: string; entityId?: string; metadata?: unknown }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, metadata) VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(
      newId(),
      entry.userId,
      entry.action,
      entry.entityType ?? null,
      entry.entityId ?? null,
      entry.metadata ? JSON.stringify(entry.metadata) : null
    )
    .run();
}

export async function logException(
  db: D1Database,
  entry: {
    type: ExceptionType;
    pickTaskId?: string;
    packSessionId?: string;
    orderId?: string;
    userId: string | null;
    notes?: string;
  }
): Promise<string> {
  const id = newId();
  await db
    .prepare(
      `INSERT INTO exception_events (id, type, pick_task_id, pack_session_id, order_id, user_id, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      entry.type,
      entry.pickTaskId ?? null,
      entry.packSessionId ?? null,
      entry.orderId ?? null,
      entry.userId,
      entry.notes ?? null
    )
    .run();
  return id;
}
