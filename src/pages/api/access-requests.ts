import type { APIRoute } from 'astro';
import { getDb, newId } from '../../lib/db';

export const POST: APIRoute = async (context) => {
  const db = getDb();
  try {
    const body = await context.request.json<{ name: string; email: string; company?: string; phone?: string; message?: string }>();
    const name = body.name?.trim();
    const email = body.email?.trim();
    if (!name || !email) return new Response(JSON.stringify({ error: 'Name and email are required' }), { status: 400 });

    await db
      .prepare(`INSERT INTO access_requests (id, name, email, company, phone, message) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(newId(), name, email, body.company?.trim() || null, body.phone?.trim() || null, body.message?.trim() || null)
      .run();

    return new Response(JSON.stringify({ ok: true }), { status: 201, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};
