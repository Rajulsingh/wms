import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getDb, newId } from '../../../../lib/db';
import { requireUser, requireOwnWarehouse, AuthError } from '../../../../lib/auth';
import { getReturnById } from '../../../../lib/returns';

const MAX_BYTES = 8 * 1024 * 1024;
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/**
 * Stores a label or product photo for a "safe to claim" inspection in the
 * RETURNS_IMAGES R2 bucket (private — see wrangler.jsonc) and hands back
 * just the R2 key, not a URL. Images are only ever served back out through
 * GET /api/returns/image.ts, which re-checks the requesting user's
 * warehouse against the return's own before streaming anything.
 */
export const POST: APIRoute = async (context) => {
  const db = getDb();
  try {
    const user = await requireUser(context, db, ['packer']);
    requireOwnWarehouse(user, user.warehouse_id);
    if (!env.RETURNS_IMAGES) {
      return new Response(JSON.stringify({ error: 'Image storage is not configured yet — ask an admin to finish setting up R2.' }), { status: 503 });
    }

    const form = await context.request.formData();
    const returnId = form.get('returnId');
    const kind = form.get('type');
    const file = form.get('file');
    if (typeof returnId !== 'string' || (kind !== 'label' && kind !== 'product') || !(file instanceof File)) {
      return new Response(JSON.stringify({ error: 'returnId, type ("label" | "product") and file are required' }), { status: 400 });
    }
    if (!ALLOWED_TYPES.has(file.type)) return new Response(JSON.stringify({ error: 'Only JPEG, PNG or WEBP images are accepted' }), { status: 400 });
    if (file.size > MAX_BYTES) return new Response(JSON.stringify({ error: 'Image is too large (8MB max)' }), { status: 400 });

    const existing = await getReturnById(db, returnId);
    if (!existing) return new Response(JSON.stringify({ error: 'Return not found' }), { status: 404 });
    if (existing.warehouseId !== user.warehouse_id) return new Response(JSON.stringify({ error: 'Not authorized for this warehouse' }), { status: 403 });

    const ext = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg';
    const key = `returns/${user.warehouse_id}/${returnId}/${kind}-${newId()}.${ext}`;
    await env.RETURNS_IMAGES.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type } });

    return new Response(JSON.stringify({ key }), { status: 201, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};
