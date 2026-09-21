import { defineMiddleware } from 'astro:middleware';

/**
 * Global security response headers — nothing set any of these before this
 * file existed.
 *
 * `script-src` and `style-src` both need `'unsafe-inline'` — checked against
 * the real production build (`astro build` + `wrangler dev`), not just dev
 * mode: every page's `<script>` block (every admin page, login, picker,
 * packer — this app has no framework, every page wires up its own vanilla
 * JS this way) gets inlined straight into the HTML by the production build,
 * not emitted as an external file the way dev mode's output misleadingly
 * suggested. A hash-based allowlist isn't practical either — these scripts
 * change on nearly every page edit, and the header would need updating in
 * lockstep with every one. This is a real, accepted trade-off, not an
 * oversight: it means CSP can't block an inline `<script>` an XSS injection
 * might write, so the escaping fixes (escapeHtml everywhere user text hits
 * innerHTML) remain the actual defense against that — this header's value is
 * everything else it still blocks (loading a script/style from any
 * *external* origin, exfiltrating via fetch/XHR to a third-party domain,
 * framing this app in someone else's page, a hijacked `<base>` tag).
 * `img-src` allows `https:` broadly since SKU thumbnails come from Amazon's
 * own CDN at whatever host it happens to use. `font-src` allows `data:`
 * because the self-hosted variable fonts are bundled as base64 `data:`
 * URIs. `object-src 'self' data:` covers `/admin/ship`'s shipping-label
 * `<embed>`, which renders a `data:application/pdf;...` URI.
 *
 * Skipped in dev (`import.meta.env.DEV`) — Vite's HMR client and dev
 * toolbar inject their own inline scripts/styles and an HMR websocket that
 * a production-strength CSP would fight with for no real benefit locally.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "object-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'"
].join('; ');

export const onRequest = defineMiddleware(async (_context, next) => {
  const response = await next();
  const headers = new Headers(response.headers);

  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Barcode/AWB scanning (scanner-client.ts) needs the camera; nothing else does.
  headers.set('Permissions-Policy', 'camera=(self), geolocation=(), microphone=()');

  if (!import.meta.env.DEV) {
    headers.set('Content-Security-Policy', CSP);
    headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
});
