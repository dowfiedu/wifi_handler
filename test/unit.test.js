import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { escapeMarkdown, normalizeMac } from '../api/request.js';
import { parseCallbackData } from '../api/webhook.js';
import { timingSafeCompare } from '../api/poll.js';

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
  test('parses auth with duration correctly', () => {
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

  test('parses deauth correctly', () => {
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
