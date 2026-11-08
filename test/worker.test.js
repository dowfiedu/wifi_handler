import { describe, it } from 'node:test';
import assert from 'node:assert';
import worker, { handleApiRoute } from '../worker.js';

describe('Cloudflare Worker & Pages Integration Tests', () => {
  it('returns 404 for unknown API route', async () => {
    const request = new Request('https://example.com/api/unknown-endpoint');
    const response = await handleApiRoute(request, {}, '/api/unknown-endpoint');
    assert.strictEqual(response.status, 404);
    const data = await response.json();
    assert.match(data.error, /Not Found/);
  });

  it('rejects /api/request with 405 for GET', async () => {
    const request = new Request('https://example.com/api/request', { method: 'GET' });
    const response = await handleApiRoute(request, {}, '/api/request');
    assert.strictEqual(response.status, 405);
  });

  it('rejects /api/poll with 401 when x-router-secret header is missing', async () => {
    const request = new Request('https://example.com/api/poll', {
      method: 'GET',
      headers: { 'x-router-secret': 'wrong-secret' }
    });
    const env = {
      ROUTER_SECRET_KEY: 'correct-secret',
      UPSTASH_REDIS_REST_URL: 'https://fake.upstash.io',
      UPSTASH_REDIS_REST_TOKEN: 'fake-token'
    };
    const response = await handleApiRoute(request, env, '/api/poll');
    assert.strictEqual(response.status, 401);
  });

  it('serves static assets fallback using env.ASSETS', async () => {
    let fetchedUrl = null;
    const fakeEnv = {
      ASSETS: {
        fetch: async (req) => {
          fetchedUrl = req.url;
          return new Response('fake html content', { status: 200 });
        }
      }
    };

    const request = new Request('https://example.com/index.html');
    const response = await worker.fetch(request, fakeEnv, {});
    assert.strictEqual(response.status, 200);
    assert.strictEqual(fetchedUrl, 'https://example.com/index.html');
  });

  it('rewrites /admin to /admin.html for static assets', async () => {
    let fetchedUrl = null;
    const fakeEnv = {
      ASSETS: {
        fetch: async (req) => {
          fetchedUrl = req.url;
          return new Response('fake admin page', { status: 200 });
        }
      }
    };

    const request = new Request('https://example.com/admin');
    const response = await worker.fetch(request, fakeEnv, {});
    assert.strictEqual(response.status, 200);
    assert.strictEqual(fetchedUrl, 'https://example.com/admin.html');
  });
});
