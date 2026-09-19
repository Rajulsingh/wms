import type { APIRoute } from 'astro';
import { clearSession } from '../../../lib/auth';

export const POST: APIRoute = async (context) => {
  clearSession(context);
  return new Response(null, { status: 204 });
};
