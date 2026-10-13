import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import requestHandler from '../api/request.js';
import webhookHandler from '../api/webhook.js';
import telegramHandler from '../api/telegram.js';
import pollHandler from '../api/poll.js';
import adminHandler from '../api/admin.js';
import loginHandler from '../api/login.js';
import pendingAuthHandler from '../api/pending-auth.js';
import confirmAuthHandler from '../api/confirm-auth.js';
import statusHandler from '../api/status.js';

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
    },
    send(data) {
      this.body = data;
      return this;
    },
    end(data) {
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

  test('/api/telegram behaves identically to /api/webhook', async () => {
    assert.equal(telegramHandler, webhookHandler);
  });

  test('/api/webhook processes auth callback and queues ndsctl auth with Terminate button', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    process.env.UPSTASH_REDIS_REST_URL = 'https://mock.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'mock-token';

    const fetchCalls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      fetchCalls.push({ url: String(url), options });
      if (String(url).includes('upstash.io')) {
        return new Response(JSON.stringify([{ result: 1 }]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return new Response(JSON.stringify({ ok: true, result: 1 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    };

    try {
      const req = {
        method: 'POST',
        body: {
          callback_query: {
            id: 'cb_123',
            data: 'auth:aa:bb:cc:dd:ee:ff:30',
            message: {
              chat: { id: 98765 },
              message_id: 42,
              text: '📶 New Wi-Fi Access Request\n👤 User: Rahim\nSelect access duration below to authorize via router:'
            },
            from: { first_name: 'AdminUser' }
          }
        }
      };
      const res = createMockRes();
      await webhookHandler(req, res);

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.ok, true);
      assert.equal(res.body.commandQueued, 'ndsctl auth aa:bb:cc:dd:ee:ff 30');

      // Verify Telegram editMessageText had the Terminate button
      const editMsgCall = fetchCalls.find(c => c.url.includes('editMessageText'));
      assert.ok(editMsgCall, 'editMessageText was called');
      const body = JSON.parse(editMsgCall.options.body);
      assert.deepEqual(body.reply_markup.inline_keyboard, [
        [{ text: '❌ Terminate', callback_data: 'deauth_aa:bb:cc:dd:ee:ff' }]
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('/api/webhook processes deauth_<mac> callback and queues ndsctl deauth', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    process.env.UPSTASH_REDIS_REST_URL = 'https://mock.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'mock-token';

    const fetchCalls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      fetchCalls.push({ url: String(url), options });
      if (String(url).includes('upstash.io')) {
        return new Response(JSON.stringify([{ result: 1 }]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return new Response(JSON.stringify({ ok: true, result: 1 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    };

    try {
      const req = {
        method: 'POST',
        body: {
          callback_query: {
            id: 'cb_456',
            data: 'deauth_aa:bb:cc:dd:ee:ff',
            message: {
              chat: { id: 98765 },
              message_id: 42,
              text: '📶 New Wi-Fi Access Request\n👤 User: Rahim\n\n✅ *Status:* Authorized (30m) by AdminUser'
            },
            from: { first_name: 'AdminUser' }
          }
        }
      };
      const res = createMockRes();
      await webhookHandler(req, res);

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.ok, true);
      assert.equal(res.body.commandQueued, 'ndsctl deauth aa:bb:cc:dd:ee:ff');

      // Verify Telegram editMessageText removed the buttons
      const editMsgCall = fetchCalls.find(c => c.url.includes('editMessageText'));
      assert.ok(editMsgCall, 'editMessageText was called');
      const body = JSON.parse(editMsgCall.options.body);
      assert.deepEqual(body.reply_markup.inline_keyboard, []);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('/api/webhook processes /start and /menu text messages by presenting keyboard menu', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    process.env.UPSTASH_REDIS_REST_URL = 'https://mock.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'mock-token';

    const fetchCalls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      fetchCalls.push({ url: String(url), options });
      return new Response(JSON.stringify({ ok: true, result: 1 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    };

    try {
      const req = {
        method: 'POST',
        body: {
          update_id: 8888,
          message: {
            text: '/start',
            chat: { id: 12345 }
          }
        }
      };
      const res = createMockRes();
      await webhookHandler(req, res);

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.ok, true);
      assert.equal(res.body.action, 'menu_shown');

      // Verify sendMessage was invoked with welcome text and persistent reply keyboard
      const sendCall = fetchCalls.find(c => c.url.includes('sendMessage'));
      assert.ok(sendCall, 'sendMessage was called');
      const body = JSON.parse(sendCall.options.body);
      assert.equal(body.chat_id, 12345);
      assert.match(body.text, /OpenWrt Wi-Fi অ্যাডমিন কন্ট্রোল সেন্টারে/);
      assert.ok(body.reply_markup.keyboard, 'Reply keyboard attached');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('/api/webhook processes /dashboard, /active, /previous, /details, /clean text commands', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    process.env.UPSTASH_REDIS_REST_URL = 'https://mock.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'mock-token';

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url).includes('upstash.io')) {
        return new Response(JSON.stringify({ result: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return new Response(JSON.stringify({ ok: true, result: 1 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    };

    try {
      const commands = ['/dashboard', '/active', '/previous', '/details', '/clean'];
      for (const cmd of commands) {
        const req = {
          method: 'POST',
          body: {
            update_id: 9999,
            message: {
              text: cmd,
              chat: { id: 12345 }
            }
          }
        };
        const res = createMockRes();
        await webhookHandler(req, res);
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.ok, true);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('/api/webhook processes menu callback query triggers', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    process.env.UPSTASH_REDIS_REST_URL = 'https://mock.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'mock-token';

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url).includes('upstash.io')) {
        return new Response(JSON.stringify({ result: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return new Response(JSON.stringify({ ok: true, result: 1 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    };

    try {
      const req = {
        method: 'POST',
        body: {
          callback_query: {
            id: 'cb_menu_1',
            data: 'menu_dashboard',
            message: {
              chat: { id: 12345 },
              message_id: 100
            }
          }
        }
      };
      const res = createMockRes();
      await webhookHandler(req, res);

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.ok, true);
      assert.equal(res.body.action, 'menu');
      assert.equal(res.body.command, 'dashboard');

      // Test menu_active callback
      const activeReq = {
        method: 'POST',
        body: {
          callback_query: {
            id: 'cb_menu_active',
            data: 'menu_active',
            message: { chat: { id: 12345 }, message_id: 101 }
          }
        }
      };
      const activeRes = createMockRes();
      await webhookHandler(activeReq, activeRes);
      assert.equal(activeRes.statusCode, 200);
      assert.equal(activeRes.body.ok, true);
      assert.equal(activeRes.body.command, 'active');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('/api/webhook blocks unauthorized chat when TELEGRAM_CHAT_ID is set', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    process.env.TELEGRAM_CHAT_ID = '99999';
    process.env.UPSTASH_REDIS_REST_URL = 'https://mock.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'mock-token';

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, result: 1 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

    try {
      const req = {
        method: 'POST',
        body: {
          update_id: 1111,
          message: {
            text: '/dashboard',
            chat: { id: 88888 }
          }
        }
      };
      const res = createMockRes();
      await webhookHandler(req, res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.ok, false);
      assert.equal(res.body.error, 'Unauthorized chat.');
    } finally {
      delete process.env.TELEGRAM_CHAT_ID;
      globalThis.fetch = originalFetch;
    }
  });

  test('/api/admin POST executes clean action successfully', async () => {
    process.env.ADMIN_PASSWORD = 'admin-secret-pass';
    process.env.UPSTASH_REDIS_REST_URL = 'https://mock.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'mock-token';

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      return new Response(JSON.stringify({ result: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    };

    try {
      const req = {
        method: 'POST',
        headers: { authorization: 'Bearer admin-secret-pass' },
        body: { action: 'clean' }
      };
      const res = createMockRes();
      await adminHandler(req, res);

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.ok, true);
      assert.equal(res.body.success, true);
      assert.match(res.body.message, /cleaned/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('/api/admin rejects unsupported HTTP method with 405', async () => {
    const req = { method: 'DELETE', headers: {} };
    const res = createMockRes();

    await adminHandler(req, res);

    assert.equal(res.statusCode, 405);
    assert.match(res.body.error, /Method DELETE Not Allowed/);
    assert.equal(res.headers['allow'], 'GET, POST');
  });

  test('/api/admin returns 500 when admin credentials are not configured', async () => {
    delete process.env.ADMIN_PASSWORD;
    delete process.env.ROUTER_SECRET_KEY;

    const req = { method: 'GET', headers: {} };
    const res = createMockRes();

    await adminHandler(req, res);

    assert.equal(res.statusCode, 500);
    assert.match(res.body.error, /Admin credentials are not configured/);
  });

  test('/api/admin rejects unauthorized requests with 401', async () => {
    process.env.ADMIN_PASSWORD = 'super-secret-admin';

    const reqWithoutAuth = { method: 'GET', headers: {} };
    const resWithoutAuth = createMockRes();
    await adminHandler(reqWithoutAuth, resWithoutAuth);
    assert.equal(resWithoutAuth.statusCode, 401);

    const reqWrongAuth = {
      method: 'GET',
      headers: { authorization: 'Bearer wrong-password' }
    };
    const resWrongAuth = createMockRes();
    await adminHandler(reqWrongAuth, resWrongAuth);
    assert.equal(resWrongAuth.statusCode, 401);
  });

  test('/api/admin POST verifies login action successfully', async () => {
    process.env.ADMIN_PASSWORD = 'correct-password';

    const req = {
      method: 'POST',
      headers: { authorization: 'Bearer correct-password' },
      body: { action: 'login' }
    };
    const res = createMockRes();

    await adminHandler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
  });

  test('/api/admin POST rejects invalid MAC address with 400', async () => {
    process.env.ADMIN_PASSWORD = 'correct-password';

    const req = {
      method: 'POST',
      headers: { authorization: 'Bearer correct-password' },
      body: { action: 'auth', mac: 'invalid-mac', duration: 60 }
    };
    const res = createMockRes();

    await adminHandler(req, res);

    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /valid MAC address/);
  });

  test('/api/admin POST rejects invalid action with 400', async () => {
    process.env.ADMIN_PASSWORD = 'correct-password';

    const req = {
      method: 'POST',
      headers: { authorization: 'Bearer correct-password' },
      body: { action: 'unknown-action', mac: '00:11:22:33:44:55' }
    };
    const res = createMockRes();

    await adminHandler(req, res);

    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /Invalid action/);
  });

  test('/api/admin POST rejects negative duration with 400', async () => {
    process.env.ADMIN_PASSWORD = 'correct-password';

    const req = {
      method: 'POST',
      headers: { authorization: 'Bearer correct-password' },
      body: { action: 'auth', mac: '00:11:22:33:44:55', duration: -10 }
    };
    const res = createMockRes();

    await adminHandler(req, res);

    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /duration/);
  });

  // ---------------------------------------------------------------------------
  // /api/login tests
  // ---------------------------------------------------------------------------
  test('/api/login rejects non-POST requests with 405', async () => {
    const req = { method: 'GET' };
    const res = createMockRes();

    await loginHandler(req, res);

    assert.equal(res.statusCode, 405);
    assert.match(res.body.error, /Method GET Not Allowed/);
  });

  test('/api/login rejects request when no valid MAC is found', async () => {
    const req = {
      method: 'POST',
      body: { name: 'Test User' }
    };
    const res = createMockRes();

    await loginHandler(req, res);

    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /Valid client MAC not found/);
  });

  test('/api/login successfully decodes FAS token and returns 200', async () => {
    const rawFas = 'clientmac=b6:30:f7:f7:11:60, clientip=192.168.2.223, gatewayaddress=192.168.2.1';
    const fasToken = Buffer.from(rawFas).toString('base64');

    const req = {
      method: 'POST',
      body: { fas: fasToken, name: 'Guest User' }
    };
    const res = createMockRes();

    await loginHandler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.mac, 'b6:30:f7:f7:11:60');
    assert.equal(res.body.ip, '192.168.2.223');
  });

  test('/api/login accepts direct mac parameter when fas is omitted', async () => {
    const req = {
      method: 'POST',
      body: { mac: 'AA:BB:CC:DD:EE:FF', ip: '10.0.0.5', name: 'Direct User' }
    };
    const res = createMockRes();

    await loginHandler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.mac, 'aa:bb:cc:dd:ee:ff');
  });

  // ---------------------------------------------------------------------------
  // /api/pending-auth tests
  // ---------------------------------------------------------------------------
  test('/api/pending-auth rejects non-GET requests with 405', async () => {
    const req = { method: 'POST', headers: {} };
    const res = createMockRes();

    await pendingAuthHandler(req, res);

    assert.equal(res.statusCode, 405);
    assert.match(res.body.error, /Method POST Not Allowed/);
  });

  test('/api/pending-auth rejects invalid x-router-secret with 401 when configured', async () => {
    process.env.ROUTER_SECRET_KEY = 'secret-key-xyz';
    const req = {
      method: 'GET',
      headers: { 'x-router-secret': 'wrong-secret' }
    };
    const res = createMockRes();

    await pendingAuthHandler(req, res);

    assert.equal(res.statusCode, 401);
    assert.match(res.body.error, /Unauthorized/);
  });

  test('/api/pending-auth returns plain text by default', async () => {
    const req = { method: 'GET', headers: {} };
    const res = createMockRes();

    await pendingAuthHandler(req, res);

    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /text\/plain/);
  });

  test('/api/pending-auth returns JSON when requested', async () => {
    const req = {
      method: 'GET',
      headers: { accept: 'application/json' }
    };
    const res = createMockRes();

    await pendingAuthHandler(req, res);

    assert.equal(res.statusCode, 200);
    assert.ok('mac' in res.body);
  });

  // ---------------------------------------------------------------------------
  // /api/confirm-auth tests
  // ---------------------------------------------------------------------------
  test('/api/confirm-auth rejects non-POST requests with 405', async () => {
    const req = { method: 'GET', headers: {} };
    const res = createMockRes();

    await confirmAuthHandler(req, res);

    assert.equal(res.statusCode, 405);
    assert.match(res.body.error, /Method GET Not Allowed/);
  });

  test('/api/confirm-auth rejects missing MAC with 400', async () => {
    const req = { method: 'POST', headers: {}, body: {} };
    const res = createMockRes();

    await confirmAuthHandler(req, res);

    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /valid MAC address/);
  });

  test('/api/confirm-auth confirms MAC via URLSearchParams string body', async () => {
    const req = {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'mac=b6:30:f7:f7:11:60'
    };
    const res = createMockRes();

    await confirmAuthHandler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.mac, 'b6:30:f7:f7:11:60');
    assert.equal(res.body.status, 'AUTHENTICATED');
  });

  test('/api/confirm-auth confirms MAC via JSON body', async () => {
    const req = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: { mac: '00:11:22:33:44:55' }
    };
    const res = createMockRes();

    await confirmAuthHandler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.mac, '00:11:22:33:44:55');
  });

  test('/api/status rejects non-GET requests with 405', async () => {
    const req = { method: 'POST' };
    const res = createMockRes();

    await statusHandler(req, res);

    assert.equal(res.statusCode, 405);
    assert.match(res.body.error, /Method POST Not Allowed/);
  });

  test('/api/status rejects missing or invalid MAC with 400', async () => {
    const req = { method: 'GET', url: 'http://localhost/api/status' };
    const res = createMockRes();

    await statusHandler(req, res);

    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /Field "mac" is required/);

    const reqInvalid = { method: 'GET', url: 'http://localhost/api/status?mac=not-a-mac' };
    const resInvalid = createMockRes();

    await statusHandler(reqInvalid, resInvalid);

    assert.equal(resInvalid.statusCode, 400);
  });

  test('/api/status returns fallback status when Redis is not configured', async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;

    const req = { method: 'GET', url: 'http://localhost/api/status?mac=aa:bb:cc:dd:ee:ff' };
    const res = createMockRes();

    await statusHandler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.mac, 'aa:bb:cc:dd:ee:ff');
    assert.equal(res.body.status, 'pending');
  });
});
