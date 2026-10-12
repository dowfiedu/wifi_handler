import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import requestHandler from '../api/request.js';
import webhookHandler from '../api/webhook.js';
import pollHandler from '../api/poll.js';

// Helper mock response factory
function createMockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(key, value) {
      this.headers[key.toLowerCase()] = value;
      return this;
    },
    json(data) {
      this.body = data;
      return this;
    }
  };
}

describe('API Endpoints Validation & Status Codes', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test('/api/request rejects non-POST requests with 405', async () => {
    const req = { method: 'GET' };
    const res = createMockRes();

    await requestHandler(req, res);

    assert.equal(res.statusCode, 405);
    assert.match(res.body.error, /Method GET Not Allowed/);
    assert.equal(res.headers['allow'], 'POST');
  });

  test('/api/request validates missing or empty name with 400', async () => {
    const req = {
      method: 'POST',
      body: { name: '', mac: '00:11:22:33:44:55' }
    };
    const res = createMockRes();

    await requestHandler(req, res);

    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /name/i);
  });

  test('/api/request validates invalid MAC address with 400', async () => {
    const req = {
      method: 'POST',
      body: { name: 'John Doe', mac: 'invalid-mac-address' }
    };
    const res = createMockRes();

    await requestHandler(req, res);

    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /mac/i);
  });

  test('/api/request returns 500 when Telegram environment variables are missing', async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;

    const req = {
      method: 'POST',
      body: { name: 'John Doe', mac: '00:11:22:33:44:55' }
    };
    const res = createMockRes();

    await requestHandler(req, res);

    assert.equal(res.statusCode, 500);
    assert.match(res.body.error, /Telegram credentials/i);
  });

  test('/api/poll rejects non-GET/POST requests with 405', async () => {
    const req = { method: 'PUT', headers: {} };
    const res = createMockRes();

    await pollHandler(req, res);

    assert.equal(res.statusCode, 405);
    assert.equal(res.headers['allow'], 'GET, POST');
  });

  test('/api/poll rejects missing or invalid x-router-secret header with 401', async () => {
    process.env.ROUTER_SECRET_KEY = 'super-secret-123';
    process.env.UPSTASH_REDIS_REST_URL = 'https://mock.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'mock-token';

    const reqWithoutHeader = { method: 'GET', headers: {} };
    const resWithoutHeader = createMockRes();
    await pollHandler(reqWithoutHeader, resWithoutHeader);
    assert.equal(resWithoutHeader.statusCode, 401);

    const reqWrongHeader = { method: 'GET', headers: { 'x-router-secret': 'wrong-key' } };
    const resWrongHeader = createMockRes();
    await pollHandler(reqWrongHeader, resWrongHeader);
    assert.equal(resWrongHeader.statusCode, 401);
  });

  test('/api/webhook returns 200 and ignores non-callback updates', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    process.env.UPSTASH_REDIS_REST_URL = 'https://mock.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'mock-token';

    const req = {
      method: 'POST',
      body: {
        update_id: 12345,
        message: { text: 'Hello' } // Regular text message, not callback_query
      }
    };
    const res = createMockRes();

    await webhookHandler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.match(res.body.message, /No callback query/);
  });
});
