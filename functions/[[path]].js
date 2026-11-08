/**
 * functions/[[path]].js
 *
 * Catch-all Cloudflare Pages Function.
 * Directs all `/api/*` requests to `handleApiRoute` from `worker.js`.
 * Non-API requests automatically fall through to `context.next()` to serve static files from `public/`.
 */

import { handleApiRoute } from '../worker.js';

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);

  // 1. Intercept all backend API calls
  if (url.pathname.startsWith('/api/')) {
    return handleApiRoute(request, env, url.pathname);
  }

  // 2. Rewrite clean URL `/admin` to `/admin.html`
  if (url.pathname === '/admin') {
    const adminUrl = new URL('/admin.html', request.url);
    return next(new Request(adminUrl, request));
  }

  // 3. Fallback to static assets (index.html, etc.)
  return next();
}
