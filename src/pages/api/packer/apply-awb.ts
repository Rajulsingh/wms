import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/db';
import { requireUser, AuthError } from '../../../lib/auth';
import { applyAwb, PackerFlowError } from '../../../lib/packer';

export const POST: APIRoute = async (context) => {
  const db = getDb();
  try {
    const user = await requireUser(context, db, ['packer']);
    const body = await context.request.json<{ packSessionId: string; awbCode: string }>();

    const result = await applyAwb(db, user.id, body.packSessionId, body.awbCode);
    return new Response(JSON.stringify({ ok: true, ...result }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    if (err instanceof PackerFlowError) {
      // Hard block, per the original spec: duplicate/invalid AWB must never let the order through as ready-to-ship.
      return new Response(JSON.stringify({ error: err.message, code: err.code, hardBlock: true }), { status: 409 });
    }
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};
