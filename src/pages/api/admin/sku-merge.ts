import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/db';
import { requireUser, AuthError } from '../../../lib/auth';
import { previewSkuMerge, mergeSku, SkuMergeError } from '../../../lib/skus';

/** Read-only preview of what a merge would move — shown before the admin commits to it. */
export const GET: APIRoute = async (context) => {
  const db = getDb();
  try {
    await requireUser(context, db, ['admin']);
    const url = new URL(context.request.url);
    const sourceCode = url.searchParams.get('sourceCode');
    const targetCode = url.searchParams.get('targetCode');
    if (!sourceCode || !targetCode) return new Response(JSON.stringify({ error: 'sourceCode and targetCode are required' }), { status: 400 });

    const preview = await previewSkuMerge(db, sourceCode, targetCode);
    return new Response(JSON.stringify(preview), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    if (err instanceof SkuMergeError) return new Response(JSON.stringify({ error: err.message, code: err.code }), { status: 409 });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};

export const POST: APIRoute = async (context) => {
  const db = getDb();
  try {
    const user = await requireUser(context, db, ['admin']);
    const body = await context.request.json<{ sourceCode: string; targetCode: string }>();

    const result = await mergeSku(db, user.id, body.sourceCode, body.targetCode);
    return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof AuthError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
    if (err instanceof SkuMergeError) return new Response(JSON.stringify({ error: err.message, code: err.code }), { status: 409 });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};
