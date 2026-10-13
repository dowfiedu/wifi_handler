import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { escapeMarkdown, normalizeMac } from '../api/request.js';
import { parseCallbackData } from '../api/webhook.js';
import { parseCallbackData as parseCallbackDataTelegram } from '../api/telegram.js';
import { timingSafeCompare } from '../api/poll.js';
import { checkAdminAuth } from '../api/admin.js';
import { parseFasToken } from '../lib/opennds.js';
import {
  formatDateTime,
  isUserActive,
  isUserTerminated,
  formatUserDetailsCard,
  formatUserDetailsList,
  formatActiveUsersList,
  formatPreviousUsersList,
  formatDashboardMessage,
  TELEGRAM_MENU_KEYBOARD,
  TELEGRAM_INLINE_MENU
} from '../lib/bot-menu.js';
import { normalizeCommandText } from '../api/webhook.js';

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

  test('parses menu callback triggers correctly', () => {
    assert.deepEqual(parseCallbackData('menu_dashboard'), { action: 'menu', command: 'dashboard' });
    assert.deepEqual(parseCallbackData('menu_active'), { action: 'menu', command: 'active' });
    assert.deepEqual(parseCallbackData('menu_previous'), { action: 'menu', command: 'previous' });
    assert.deepEqual(parseCallbackData('menu_history'), { action: 'menu', command: 'previous' });
    assert.deepEqual(parseCallbackData('menu_details'), { action: 'menu', command: 'details' });
    assert.deepEqual(parseCallbackData('menu_users'), { action: 'menu', command: 'details' });
    assert.deepEqual(parseCallbackData('menu_clean'), { action: 'menu', command: 'clean' });
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

describe('lib/bot-menu.js Helpers & Formatters', () => {
  test('formatDateTime formats valid date and handles missing/invalid gracefully', () => {
    const fixed = '2026-10-13T12:30:00.000Z';
    const result = formatDateTime(fixed);
    assert.equal(result.date, '13 Oct 2026');
    assert.match(result.time, /12:30:00/);

    const empty = formatDateTime(null);
    assert.equal(empty.date, 'N/A');
    assert.equal(empty.time, 'N/A');

    const invalid = formatDateTime('invalid-date-string');
    assert.equal(invalid.date, 'N/A');
    assert.equal(invalid.time, 'N/A');
  });

  test('isUserActive identifies active, unlimited, and expired users', () => {
    // Unlimited active
    assert.equal(isUserActive({ status: 'authorized', duration: 0 }), true);
    assert.equal(isUserActive({ status: 'AUTHENTICATED', duration: 0 }), true);

    // Active within duration (5 mins ago, 60m duration)
    const recentIso = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    assert.equal(isUserActive({ status: 'authorized', duration: 60, reviewedAt: recentIso }), true);

    // Expired (120 mins ago, 60m duration)
    const expiredIso = new Date(Date.now() - 120 * 60 * 1000).toISOString();
    assert.equal(isUserActive({ status: 'authorized', duration: 60, reviewedAt: expiredIso }), false);

    // Terminated or pending
    assert.equal(isUserActive({ status: 'terminated' }), false);
    assert.equal(isUserActive({ status: 'pending' }), false);
  });

  test('isUserTerminated detects terminated and rejected statuses', () => {
    assert.equal(isUserTerminated({ status: 'terminated' }), true);
    assert.equal(isUserTerminated({ status: 'rejected' }), true);
    assert.equal(isUserTerminated({ status: 'authorized' }), false);
    assert.equal(isUserTerminated({ status: 'pending' }), false);
  });

  test('formatUserDetailsCard outputs specific layout requested by user', () => {
    const user = {
      name: 'সাকিব আল হাসান',
      mac: '4a:8b:9c:1d:2e:3f',
      ip: '192.168.1.105',
      requestedAt: '2026-10-13T10:00:00.000Z'
    };

    const card = formatUserDetailsCard(user);

    // User specification:
    // 1. নাম (Name)
    // 2. ডেট (Date)
    // 3. ম্যাক অ্যাড্রেস (MAC address)
    // 4. আইপি অ্যাড্রেস (IP address)
    // 5. টাইমস্ট্যাম্প (Timestamp)
    assert.match(card, /👤 \*নাম:\* সাকিব আল হাসান/);
    assert.match(card, /📅 \*তারিখ:\* 13 Oct 2026/);
    assert.match(card, /🏷 \*ম্যাক অ্যাড্রেস:\* `4a:8b:9c:1d:2e:3f`/);
    assert.match(card, /🌐 \*আইপি অ্যাড্রেস:\* `192\.168\.1\.105`/);
    assert.match(card, /⏰ \*টাইমস্ট্যাম্প:\*/);
  });

  test('formatDashboardMessage strictly omits terminated users and displays active only', () => {
    const activeUsers = [
      { name: 'রহিম', mac: 'aa:bb:cc:dd:ee:ff', duration: 60 },
      { name: 'করিম', mac: '11:22:33:44:55:66', duration: 0 }
    ];

    const dashboard = formatDashboardMessage(activeUsers, 2);

    assert.match(dashboard, /ওয়াইফাই নেটওয়ার্ক ড্যাশবোর্ড/);
    assert.match(dashboard, /কারেন্টলি অ্যাক্টিভ ইউজার:\* 2 জন/);
    assert.match(dashboard, /পেন্ডিং রাউটার কিউ:\* 2 টি/);
    assert.match(dashboard, /রহিম/);
    assert.match(dashboard, /করিম/);
  });

  test('formatActiveUsersList formats count and details for active users', () => {
    const activeUsers = [
      { name: 'তানভীর', mac: 'bb:cc:dd:ee:ff:00', duration: 30, ip: '192.168.1.55' }
    ];
    const list = formatActiveUsersList(activeUsers);
    assert.match(list, /মোট কানেক্টেড ইউজার:\* 1 জন/);
    assert.match(list, /তানভীর/);
    assert.match(list, /30m/);

    const emptyList = formatActiveUsersList([]);
    assert.match(emptyList, /বর্তমানে কোনো ইউজার অ্যাক্টিভ বা কানেক্টেড নেই/);
  });

  test('formatPreviousUsersList formats previous session list', () => {
    const previous = [
      { name: 'আলিফ', mac: 'cc:dd:ee:ff:00:11', status: 'terminated' }
    ];
    const list = formatPreviousUsersList(previous);
    assert.match(list, /মোট পূর্ববর্তী ইউজার:\* 1 জন/);
    assert.match(list, /আলিফ/);
    assert.match(list, /Terminated/);

    const empty = formatPreviousUsersList([]);
    assert.match(empty, /কোনো পূর্ববর্তী ইউজারের হিস্ট্রি পাওয়া যায়নি/);
  });

  test('normalizeCommandText maps English and Bengali command strings', () => {
    assert.equal(normalizeCommandText('/start'), 'menu');
    assert.equal(normalizeCommandText('menu'), 'menu');
    assert.equal(normalizeCommandText('মেনু'), 'menu');
    assert.equal(normalizeCommandText('/dashboard'), 'dashboard');
    assert.equal(normalizeCommandText('📊 ড্যাশবোর্ড'), 'dashboard');
    assert.equal(normalizeCommandText('/active'), 'active');
    assert.equal(normalizeCommandText('🟢 অ্যাক্টিভ ইউজার'), 'active');
    assert.equal(normalizeCommandText('/previous'), 'previous');
    assert.equal(normalizeCommandText('👥 প্রিভিয়াস ইউজার'), 'previous');
    assert.equal(normalizeCommandText('/history'), 'previous');
    assert.equal(normalizeCommandText('/details'), 'details');
    assert.equal(normalizeCommandText('📋 ইউজার ডিটেইলস'), 'details');
    assert.equal(normalizeCommandText('/clean'), 'clean');
    assert.equal(normalizeCommandText('🧹 ক্লিন ড্যাশবোর্ড'), 'clean');
    assert.equal(normalizeCommandText('something-else'), null);
  });
});


