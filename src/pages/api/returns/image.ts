import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getDb } from '../../../lib/db';
import { requireUser, requireOwnWarehouse, AuthError } from '../../../lib/auth';
import { getReturnById } from '../../../lib/returns';

/** Streams a return's label/product photo back out — never a public R2 URL. Re-checks the requesting user's own warehouse against the return's before touching R2, same as every other cross-warehouse guard in this app. */
export const GET: APIRoute = async (context) => {
  const db = getDb();
  try {
    const user = await requireUser(context, db);
    requireOwnWarehouse(user, user.warehouse_id);
    if (!env.RETURNS_IMAGES) return new Response('Image storage is not configured yet', { status: 503 });

    const url = new URL(context.request.url);
    const returnId = url.searchParams.get('returnId');
    const kind = url.searchParams.get('type');
    if (!returnId || (kind !== 'label' && kind !== 'product')) return new Response('returnId and type are required', { status: 400 });

    const row = await getReturnById(db, returnId);
    if (!row) return new Response('Not found', { status: 404 });
    if (row.warehouseId !== user.warehouse_id) return new Response('Not authorized for this warehouse', { status: 403 });

    const key = kind === 'label' ? row.labelImageKey : row.productImageKey;
    if (!key) return new Response('No image uploaded for this return', { status: 404 });

    const object = await env.RETURNS_IMAGES.get(key);
    if (!object) return new Response('Not found', { status: 404 });
    return new Response(object.body, {
      status: 200,
      headers: { 'Content-Type': object.httpMetadata?.contentType ?? 'application/octet-stream', 'Cache-Control': 'private, max-age=3600' }
    });
  } catch (err) {
    if (err instanceof AuthError) return new Response(err.message, { status: err.status });
    return new Response((err as Error).message, { status: 500 });
  }
};
