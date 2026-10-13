import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { escapeMarkdown, normalizeMac } from '../api/request.js';
import { parseCallbackData } from '../api/webhook.js';
import { parseCallbackData as parseCallbackDataTelegram } from '../api/telegram.js';
import { timingSafeCompare } from '../api/poll.js';
import { checkAdminAuth } from '../api/admin.js';
import { parseFasToken } from '../lib/opennds.js';

describe('api/request.js Helpers', () => {
  test('escapeMarkdown escapes Markdown special characters', () => {
    assert.equal(escapeMarkdown('Alice *Bob* _Charlie_ `test` [link]'), 'Alice \\*Bob\\* \\_Charlie\\_ \\`test\\` \\[link\\]');
    assert.equal(escapeMarkdown(''), '');
    assert.equal(escapeMarkdown('John Doe'), 'John Doe');
  });

  test('normalizeMac formats MAC address properly', () => {
    assert.equal(normalizeMac('AA:BB:CC:DD:EE:FF'), 'aa:bb:cc:dd:ee:ff');
    assert.equal(normalizeMac('aa-bb-cc-dd-ee-ff'), 'aa:bb:cc:dd:ee:ff');
    assert.equal(normalizeMac('  00:11:22:33:44:55  '), '00:11:22:33:44:55');
  });
});

describe('api/webhook.js Callback Parsing', () => {
  test('parses auth with 30 minutes duration correctly', () => {
    const result = parseCallbackData('auth:00:11:22:33:44:55:30');
    assert.deepEqual(result, {
      action: 'auth',
      mac: '00:11:22:33:44:55',
      duration: 30
    });
  });

  test('parses auth with 60 minutes (1 hour) duration correctly', () => {
    const result = parseCallbackData('auth:00:11:22:33:44:55:60');
    assert.deepEqual(result, {
      action: 'auth',
      mac: '00:11:22:33:44:55',
      duration: 60
    });
  });

  test('parses auth with unlimited (0) duration', () => {
    const result = parseCallbackData('auth:aa:bb:cc:dd:ee:ff:0');
    assert.deepEqual(result, {
      action: 'auth',
      mac: 'aa:bb:cc:dd:ee:ff',
      duration: 0
    });
  });

  test('parses auth with 3 hours (180)', () => {
    const result = parseCallbackData('auth:AA:BB:CC:DD:EE:FF:180');
    assert.deepEqual(result, {
      action: 'auth',
      mac: 'aa:bb:cc:dd:ee:ff',
      duration: 180
    });
  });

  test('parses auth with underscore separator auth_<mac>_<duration>', () => {
    const result = parseCallbackData('auth_00:11:22:33:44:55_60');
    assert.deepEqual(result, {
      action: 'auth',
      mac: '00:11:22:33:44:55',
      duration: 60
    });
  });

  test('parses deauth_<mac> terminate button callback correctly', () => {
    const result = parseCallbackData('deauth_00:11:22:33:44:55');
    assert.deepEqual(result, {
      action: 'deauth',
      mac: '00:11:22:33:44:55',
      duration: null
    });
  });

  test('parses deauth:<mac> correctly', () => {
    const result = parseCallbackData('deauth:00:11:22:33:44:55');
    assert.deepEqual(result, {
      action: 'deauth',
      mac: '00:11:22:33:44:55',
      duration: null
    });
  });

  test('rejects invalid or malformed callback data', () => {
    assert.equal(parseCallbackData(''), null);
    assert.equal(parseCallbackData(null), null);
    assert.equal(parseCallbackData('unknown:00:11:22:33:44:55'), null);
    assert.equal(parseCallbackData('auth:invalid-mac:60'), null);
    assert.equal(parseCallbackData('auth:00:11:22:33:44:55:notanumber'), null);
    assert.equal(parseCallbackData('auth:00:11:22:33:44:55:-10'), null);
    assert.equal(parseCallbackData('deauth:invalid-mac'), null);
    assert.equal(parseCallbackData('deauth_invalid-mac'), null);
  });

  test('api/telegram.js correctly aliases parseCallbackData', () => {
    assert.equal(parseCallbackDataTelegram, parseCallbackData);
  });
});

describe('api/poll.js Security Helpers', () => {
  test('timingSafeCompare correctly compares equal and unequal strings', () => {
    assert.equal(timingSafeCompare('secret-key-123', 'secret-key-123'), true);
    assert.equal(timingSafeCompare('secret-key-123', 'secret-key-456'), false);
    assert.equal(timingSafeCompare('secret-key-123', 'short'), false);
    assert.equal(timingSafeCompare('', 'secret'), false);
    assert.equal(timingSafeCompare(null, 'secret'), false);
  });
});

describe('api/admin.js Security & Authentication', () => {
  test('checkAdminAuth authenticates Bearer token correctly', () => {
    const req = { headers: { authorization: 'Bearer my-secret-pass' } };
    assert.equal(checkAdminAuth(req, 'my-secret-pass'), true);
    assert.equal(checkAdminAuth(req, 'wrong-pass'), false);
  });

  test('checkAdminAuth authenticates x-admin-password header', () => {
    const req = { headers: { 'x-admin-password': 'custom-header-secret' } };
    assert.equal(checkAdminAuth(req, 'custom-header-secret'), true);
    assert.equal(checkAdminAuth(req, 'wrong-secret'), false);
  });

  test('checkAdminAuth authenticates query parameter', () => {
    const req = { url: '/api/admin?password=query-secret-123', headers: {} };
    assert.equal(checkAdminAuth(req, 'query-secret-123'), true);
    assert.equal(checkAdminAuth(req, 'another-secret'), false);
  });

  test('checkAdminAuth rejects missing or empty credentials', () => {
    assert.equal(checkAdminAuth({ headers: {} }, 'my-pass'), false);
    assert.equal(checkAdminAuth({ headers: { authorization: '' } }, 'my-pass'), false);
    assert.equal(checkAdminAuth(null, 'my-pass'), false);
    assert.equal(checkAdminAuth({ headers: {} }, ''), false);
  });
});

describe('lib/opennds.js FAS Token Parsing', () => {
  test('parses standard base64 FAS token with MAC, IP, and gateway correctly', () => {
    const rawPayload = 'clientmac=b6:30:f7:f7:11:60, clientip=192.168.2.223, gatewayaddress=192.168.2.1:2050, gatewayname=openNDS-Home';
    const base64Token = Buffer.from(rawPayload).toString('base64');

    const result = parseFasToken(base64Token);
    assert.equal(result.clientMac, 'b6:30:f7:f7:11:60');
    assert.equal(result.clientIp, '192.168.2.223');
    assert.equal(result.gatewayAddress, '192.168.2.1');
  });

  test('normalizes uppercase MAC and hyphenated MAC to lowercase colon format', () => {
    const rawPayload = 'clientmac=AA-BB-CC-DD-EE-FF, clientip=10.0.0.15';
    const base64Token = Buffer.from(rawPayload).toString('base64');

    const result = parseFasToken(base64Token);
    assert.equal(result.clientMac, 'aa:bb:cc:dd:ee:ff');
    assert.equal(result.clientIp, '10.0.0.15');
    assert.equal(result.gatewayAddress, null);
  });

  test('decodes URL-encoded base64 FAS token properly', () => {
    const rawPayload = 'clientmac=00:11:22:33:44:55, clientip=192.168.1.50, gatewayaddress=192.168.1.1';
    const base64Token = Buffer.from(rawPayload).toString('base64');
    const urlEncoded = encodeURIComponent(base64Token);

    const result = parseFasToken(urlEncoded);
    assert.equal(result.clientMac, '00:11:22:33:44:55');
    assert.equal(result.clientIp, '192.168.1.50');
    assert.equal(result.gatewayAddress, '192.168.1.1');
  });

  test('safely handles empty, invalid, or non-base64 input', () => {
    assert.deepEqual(parseFasToken(''), { clientMac: null, clientIp: null, gatewayAddress: null });
    assert.deepEqual(parseFasToken(null), { clientMac: null, clientIp: null, gatewayAddress: null });
    assert.deepEqual(parseFasToken(undefined), { clientMac: null, clientIp: null, gatewayAddress: null });
    assert.deepEqual(parseFasToken('not_valid_base64_data_!!!'), { clientMac: null, clientIp: null, gatewayAddress: null });
  });
});

