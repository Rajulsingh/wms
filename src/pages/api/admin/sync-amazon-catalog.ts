import type { APIRoute } from 'astro';
import { getDb, logAudit } from '../../../lib/db';
import { requireUser, AuthError } from '../../../lib/auth';
import { syncAmazonCatalog } from '../../../lib/catalog-sync';

/**
 * Streams newline-delimited JSON instead of a single JSON response — a full
 * catalog sync can walk up to 50 pages against Amazon before it's done, and
 * the admin UI has nowhere to show real progress if the whole thing is one
 * request/response round trip. Each line is either a `{"type":"progress",...}`
 * update or the final `{"type":"done",...}` (matching the old response
 * shape) / `{"type":"error",...}`. A client not written to expect streaming
 * (e.g. `curl`) still gets valid JSON per line, just not a single object.
 */
export const POST: APIRoute = async (context) => {
  const db = getDb();
  const encoder = new TextEncoder();

  try {
    const user = await requireUser(context, db, ['admin']);

    const stream = new ReadableStream({
      async start(controller) {
        const send = (obj: unknown) => controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'));
        try {
          const result = await syncAmazonCatalog(db, (p) => send({ type: 'progress', ...p }));
          await logAudit(db, { userId: user.id, action: 'catalog.sync', metadata: result });
          send({ type: 'done', ...result });
        } catch (err) {
          send({ type: 'error', error: (err as Error).message });
        } finally {
          controller.close();
        }
      }
    });

    return new Response(stream, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};
