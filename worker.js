/**
 * worker.js
 *
 * Universal Cloudflare Worker & Pages entry point for ArcherGuard.
 * - Routes all `/api/*` requests to their respective handlers.
 * - Injects Cloudflare environment variables into `process.env` for seamless compatibility.
 * - Falls back to static assets (`public/`) via `env.ASSETS.fetch()`.
 */

import requestHandler from './api/request.js';
import webhookHandler from './api/webhook.js';
import pollHandler from './api/poll.js';
import adminHandler from './api/admin.js';
import loginHandler from './api/login.js';
import pendingAuthHandler from './api/pending-auth.js';
import confirmAuthHandler from './api/confirm-auth.js';
import statusHandler from './api/status.js';
import routerHandler from './api/router.js';
import deauthHandler from './api/deauth.js';
import voucherHandler from './api/voucher.js';

const routes = {
  '/api/login': loginHandler,
  '/api/request': requestHandler,
  '/api/poll': pollHandler,
  '/api/status': statusHandler,
  '/api/admin': adminHandler,
  '/api/webhook': webhookHandler,
  '/api/voucher': voucherHandler,
  '/api/confirm-auth': confirmAuthHandler,
  '/api/deauth': deauthHandler,
  '/api/pending-auth': pendingAuthHandler,
  '/api/router': routerHandler
};

/**
 * Executes a Node.js-style (req, res) handler inside Cloudflare Worker runtime
 */
export async function handleApiRoute(request, env, pathname) {
  const handler = routes[pathname];
  if (!handler) {
    return new Response(JSON.stringify({ error: `Not Found: ${pathname}` }), {
      status: 404,
      headers: { 'content-type': 'application/json' }
    });
  }

  // Inject Cloudflare env variables into process.env
  if (typeof process === 'undefined') {
    globalThis.process = { env: {} };
  } else if (!process.env) {
    process.env = {};
  }
  if (env && typeof env === 'object') {
    Object.assign(process.env, env);
  }

  const url = new URL(request.url);
  const query = Object.fromEntries(url.searchParams.entries());
  const headers = {};
  for (const [key, value] of request.headers.entries()) {
    headers[key.toLowerCase()] = value;
  }

  let body = null;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const contentType = headers['content-type'] || '';
    if (contentType.includes('application/json')) {
      try {
        body = await request.json();
      } catch {
        body = null;
      }
    } else if (contentType.includes('application/x-www-form-urlencoded')) {
      try {
        const text = await request.text();
        const params = new URLSearchParams(text);
        body = Object.fromEntries(params.entries());
      } catch {
        body = null;
      }
    } else {
      try {
        body = await request.text();
      } catch {
        body = null;
      }
    }
  }

  const req = {
    method: request.method,
    headers,
    url: request.url,
    query,
    body
  };

  let statusCode = 200;
  const resHeaders = new Headers();
  let resBody = '';

  const res = {
    status(code) {
      statusCode = code;
      return res;
    },
    setHeader(name, val) {
      resHeaders.set(name, val);
      return res;
    },
    json(data) {
      if (!resHeaders.has('content-type')) {
        resHeaders.set('content-type', 'application/json');
      }
      resBody = JSON.stringify(data);
      return res;
    },
    send(data) {
      if (typeof data === 'object' && data !== null) {
        return res.json(data);
      }
      resBody = String(data ?? '');
      return res;
    },
    end(data) {
      if (data !== undefined && data !== null) {
        if (typeof data === 'object') {
          return res.json(data);
        }
        resBody = String(data);
      }
      return res;
    }
  };

  try {
    await handler(req, res);
  } catch (err) {
    console.error(`[Worker API Error] ${pathname}:`, err);
    return new Response(JSON.stringify({ error: 'Internal Server Error', details: err?.message || String(err) }), {
      status: 500,
      headers: { 'content-type': 'application/json' }
    });
  }

  return new Response(resBody, {
    status: statusCode,
    headers: resHeaders
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // API Routing
    if (url.pathname.startsWith('/api/')) {
      return handleApiRoute(request, env, url.pathname);
    }

    // Rewrite clean URL `/admin` to `/admin.html`
    if (url.pathname === '/admin') {
      const adminUrl = new URL('/admin.html', request.url);
      if (env.ASSETS && typeof env.ASSETS.fetch === 'function') {
        return env.ASSETS.fetch(new Request(adminUrl, request));
      }
    }

    // Static Asset fallback
    if (env.ASSETS && typeof env.ASSETS.fetch === 'function') {
      return env.ASSETS.fetch(request);
    }

    return new Response('Not Found', { status: 404 });
  }
};
