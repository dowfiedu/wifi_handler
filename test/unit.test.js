import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { escapeMarkdown, normalizeMac } from '../api/request.js';
import { parseCallbackData, parseCustomAuthMessage, normalizeDigits, parseDurationString } from '../api/webhook.js';
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
  buildActiveUsersKeyboard,
  buildSingleUserDeauthKeyboard,
  buildDefaultAuthKeyboard,
  buildUnlimitedKeyboard,
  formatSingleActiveUserCard,
  formatDisconnectCard,
  TELEGRAM_MENU_KEYBOARD,
  TELEGRAM_INLINE_MENU,
  trackChatMessage,
  deleteTelegramMessages,
  deleteTelegramMessage,
  clearChatHistory
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

  test('parses unlim_sess, unlim_perm, and unlim_back callbacks correctly', () => {
    assert.deepEqual(parseCallbackData('unlim_sess:00:11:22:33:44:55'), {
      action: 'unlim_sess',
      mac: '00:11:22:33:44:55',
      duration: 0,
      mode: 'session'
    });
    assert.deepEqual(parseCallbackData('unlim_perm:00:11:22:33:44:55'), {
      action: 'unlim_perm',
      mac: '00:11:22:33:44:55',
      duration: 0,
      mode: 'permanent'
    });
    assert.deepEqual(parseCallbackData('unlim_back:00:11:22:33:44:55'), {
      action: 'unlim_back',
      mac: '00:11:22:33:44:55',
      duration: null
    });
  });

  test('api/telegram.js correctly aliases parseCallbackData', () => {
    assert.equal(parseCallbackDataTelegram, parseCallbackData);
  });
});

describe('api/webhook.js Custom Duration & Message Parsing', () => {
  const sampleCard = `📶 *New Wi-Fi Access Request*
━━━━━━━━━━━━━━━━━━━━
👤 *User:* Sabbir
🏷 *MAC:* \`aa:bb:cc:dd:ee:ff\`
🌐 *IP:* \`192.168.2.100\`
⏰ *Timestamp:* Oct 14, 2026, 7:00:00 PM (BST)
━━━━━━━━━━━━━━━━━━━━
Select duration below or reply with custom minutes (e.g. 15):`;

  test('normalizes Bengali digits correctly', () => {
    assert.equal(normalizeDigits('১৫ মিনিট'), '15 মিনিট');
    assert.equal(normalizeDigits('০১২৩৪৫৬৭৮৯'), '0123456789');
  });

  test('parses direct commands with MAC and duration', () => {
    assert.deepEqual(parseCustomAuthMessage('/auth aa:bb:cc:dd:ee:ff 45'), {
      action: 'auth',
      mac: 'aa:bb:cc:dd:ee:ff',
      duration: 45
    });
    assert.deepEqual(parseCustomAuthMessage('/approve AA:BB:CC:DD:EE:FF 120'), {
      action: 'auth',
      mac: 'aa:bb:cc:dd:ee:ff',
      duration: 120
    });
    assert.deepEqual(parseCustomAuthMessage('/auth aa:bb:cc:dd:ee:ff'), {
      action: 'auth',
      mac: 'aa:bb:cc:dd:ee:ff',
      duration: 60
    });
    assert.deepEqual(parseCustomAuthMessage('/deauth aa:bb:cc:dd:ee:ff'), {
      action: 'deauth',
      mac: 'aa:bb:cc:dd:ee:ff',
      duration: null
    });
  });

  test('parses parseDurationString across all English and Bengali variations', () => {
    assert.equal(parseDurationString('১ মিনিট'), 1);
    assert.equal(parseDurationString('১মিনিট'), 1);
    assert.equal(parseDurationString('১ মিনিট।'), 1);
    assert.equal(parseDurationString('১ মিনিট.'), 1);
    assert.equal(parseDurationString('১ মিনিট সময়'), 1);
    assert.equal(parseDurationString('১ মিনিট সময়'), 1);
    assert.equal(parseDurationString('১ মিনিটের জন্য'), 1);
    assert.equal(parseDurationString('১ মিনিট এক্সেস'), 1);
    assert.equal(parseDurationString('১মিঃ'), 1);
    assert.equal(parseDurationString('১ মি.'), 1);
    assert.equal(parseDurationString('১'), 1);
    assert.equal(parseDurationString('1'), 1);
    assert.equal(parseDurationString('1m'), 1);
    assert.equal(parseDurationString('1 min'), 1);
    assert.equal(parseDurationString('1 minute'), 1);
    assert.equal(parseDurationString('15'), 15);
    assert.equal(parseDurationString('15m'), 15);
    assert.equal(parseDurationString('15 mins'), 15);
    assert.equal(parseDurationString('15 মিনিট'), 15);
    assert.equal(parseDurationString('1h'), 60);
    assert.equal(parseDurationString('2 hrs'), 120);
    assert.equal(parseDurationString('1.5h'), 90);
    assert.equal(parseDurationString('১ ঘন্টা'), 60);
    assert.equal(parseDurationString('২ ঘণ্টা'), 120);
    assert.equal(parseDurationString('0'), 0);
    assert.equal(parseDurationString('unlimited'), 0);
    assert.equal(parseDurationString('আনলিমিটেড'), 0);
    assert.equal(parseDurationString('reject'), -1);
    assert.equal(parseDurationString('বাতিল'), -1);
    assert.equal(parseDurationString('random text'), null);
  });

  test('parses reply-to-card with custom minutes and suffixes', () => {
    // 1 minute cases
    assert.deepEqual(parseCustomAuthMessage('১ মিনিট', sampleCard), {
      action: 'auth',
      mac: 'aa:bb:cc:dd:ee:ff',
      duration: 1
    });
    assert.deepEqual(parseCustomAuthMessage('১মিনিট', sampleCard), {
      action: 'auth',
      mac: 'aa:bb:cc:dd:ee:ff',
      duration: 1
    });
    assert.deepEqual(parseCustomAuthMessage('১ মিনিট।', sampleCard), {
      action: 'auth',
      mac: 'aa:bb:cc:dd:ee:ff',
      duration: 1
    });

    // Plain numbers and suffixes
    assert.deepEqual(parseCustomAuthMessage('15', sampleCard), {
      action: 'auth',
      mac: 'aa:bb:cc:dd:ee:ff',
      duration: 15
    });
    assert.deepEqual(parseCustomAuthMessage('10m', sampleCard), {
      action: 'auth',
      mac: 'aa:bb:cc:dd:ee:ff',
      duration: 10
    });
    assert.deepEqual(parseCustomAuthMessage('20 mins', sampleCard), {
      action: 'auth',
      mac: 'aa:bb:cc:dd:ee:ff',
      duration: 20
    });
    assert.deepEqual(parseCustomAuthMessage('/auth 25', sampleCard), {
      action: 'auth',
      mac: 'aa:bb:cc:dd:ee:ff',
      duration: 25
    });
    assert.deepEqual(parseCustomAuthMessage('১৫ মিনিট', sampleCard), {
      action: 'auth',
      mac: 'aa:bb:cc:dd:ee:ff',
      duration: 15
    });
  });

  test('parses reply-to-card with hours', () => {
    assert.deepEqual(parseCustomAuthMessage('1h', sampleCard), {
      action: 'auth',
      mac: 'aa:bb:cc:dd:ee:ff',
      duration: 60
    });
    assert.deepEqual(parseCustomAuthMessage('2 hrs', sampleCard), {
      action: 'auth',
      mac: 'aa:bb:cc:dd:ee:ff',
      duration: 120
    });
    assert.deepEqual(parseCustomAuthMessage('1.5h', sampleCard), {
      action: 'auth',
      mac: 'aa:bb:cc:dd:ee:ff',
      duration: 90
    });
    assert.deepEqual(parseCustomAuthMessage('১ ঘন্টা', sampleCard), {
      action: 'auth',
      mac: 'aa:bb:cc:dd:ee:ff',
      duration: 60
    });
  });

  test('parses reply-to-card with unlimited or rejection', () => {
    assert.deepEqual(parseCustomAuthMessage('unlimited', sampleCard), {
      action: 'auth',
      mac: 'aa:bb:cc:dd:ee:ff',
      duration: 0
    });
    assert.deepEqual(parseCustomAuthMessage('0', sampleCard), {
      action: 'auth',
      mac: 'aa:bb:cc:dd:ee:ff',
      duration: 0
    });
    assert.deepEqual(parseCustomAuthMessage('আনলিমিটেড', sampleCard), {
      action: 'auth',
      mac: 'aa:bb:cc:dd:ee:ff',
      duration: 0
    });
    assert.deepEqual(parseCustomAuthMessage('reject', sampleCard), {
      action: 'deauth',
      mac: 'aa:bb:cc:dd:ee:ff',
      duration: null
    });
    assert.deepEqual(parseCustomAuthMessage('বাতিল', sampleCard), {
      action: 'deauth',
      mac: 'aa:bb:cc:dd:ee:ff',
      duration: null
    });
  });

  test('parses reply-to-card with permanent or session keywords', () => {
    assert.deepEqual(parseCustomAuthMessage('স্থায়ী', sampleCard), {
      action: 'auth',
      mac: 'aa:bb:cc:dd:ee:ff',
      duration: 0,
      mode: 'permanent'
    });
    assert.deepEqual(parseCustomAuthMessage('স্থায়ী', sampleCard), {
      action: 'auth',
      mac: 'aa:bb:cc:dd:ee:ff',
      duration: 0,
      mode: 'permanent'
    });
    assert.deepEqual(parseCustomAuthMessage('permanent', sampleCard), {
      action: 'auth',
      mac: 'aa:bb:cc:dd:ee:ff',
      duration: 0,
      mode: 'permanent'
    });
    assert.deepEqual(parseCustomAuthMessage('এককালীন', sampleCard), {
      action: 'auth',
      mac: 'aa:bb:cc:dd:ee:ff',
      duration: 0,
      mode: 'session'
    });
    assert.deepEqual(parseCustomAuthMessage('session', sampleCard), {
      action: 'auth',
      mac: 'aa:bb:cc:dd:ee:ff',
      duration: 0,
      mode: 'session'
    });
  });

  test('handles duration messages without reply or without MAC in reply', () => {
    // When reply has no MAC or when reply is omitted, mac is null (for auto-resolution in handler)
    assert.deepEqual(parseCustomAuthMessage('15', 'No MAC address in this message'), {
      action: 'auth',
      mac: null,
      duration: 15
    });
    assert.deepEqual(parseCustomAuthMessage('১ মিনিট', null), {
      action: 'auth',
      mac: null,
      duration: 1
    });
    assert.deepEqual(parseCustomAuthMessage('reject', null), {
      action: 'deauth',
      mac: null,
      duration: null
    });
  });

  test('returns null when text is not a duration or command', () => {
    assert.equal(parseCustomAuthMessage('hello world', sampleCard), null);
    assert.equal(parseCustomAuthMessage('', sampleCard), null);
    assert.equal(parseCustomAuthMessage(null, sampleCard), null);
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
  test('formatDateTime formats valid date in Asia/Dhaka BST and handles missing/invalid gracefully', () => {
    const fixed = '2026-10-13T12:30:00.000Z';
    const result = formatDateTime(fixed);
    assert.equal(result.date, '13 Oct 2026');
    assert.match(result.time, /06:30:00 PM BST/);

    // Can also format in explicit timezone if requested
    const utcResult = formatDateTime(fixed, 'UTC');
    assert.match(utcResult.time, /12:30:00/);

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

    assert.match(dashboard, /সক্রিয় নেটওয়ার্ক ইউজার/);
    assert.match(dashboard, /মোট কানেক্টেড ইউজার:\* 2 জন/);
    assert.match(dashboard, /পেন্ডিং কিউ:\* 2 টি/);
    assert.match(dashboard, /রহিম/);
    assert.match(dashboard, /করিম/);
  });

  test('buildActiveUsersKeyboard generates inline disconnect buttons for each active user', () => {
    const activeUsers = [
      { name: 'Sabbir', mac: 'aa:bb:cc:dd:ee:01' },
      { name: 'LongNamePersonExtremelyLong', mac: 'aa:bb:cc:dd:ee:02' }
    ];

    const markup = buildActiveUsersKeyboard(activeUsers);
    assert.ok(markup && markup.inline_keyboard);
    assert.equal(markup.inline_keyboard.length, 2);
    assert.match(markup.inline_keyboard[0][0].text, /❌ সংযোগ বিচ্ছিন্ন: Sabbir/);
    assert.equal(markup.inline_keyboard[0][0].callback_data, 'deauth_aa:bb:cc:dd:ee:01');
    assert.equal(markup.inline_keyboard[1][0].callback_data, 'deauth_aa:bb:cc:dd:ee:02');

    assert.equal(buildActiveUsersKeyboard([]), null);
    assert.equal(buildActiveUsersKeyboard(null), null);
  });

  test('TELEGRAM_MENU_KEYBOARD is modern 2x2 grid with is_persistent enabled', () => {
    assert.equal(TELEGRAM_MENU_KEYBOARD.is_persistent, true);
    assert.equal(TELEGRAM_MENU_KEYBOARD.resize_keyboard, true);
    assert.equal(TELEGRAM_MENU_KEYBOARD.keyboard.length, 2);
    assert.equal(TELEGRAM_MENU_KEYBOARD.keyboard[0].length, 2);
    assert.equal(TELEGRAM_MENU_KEYBOARD.keyboard[1].length, 2);
    // Verifies redundant dashboard button is omitted
    const allButtons = TELEGRAM_MENU_KEYBOARD.keyboard.flat().map(b => b.text);
    assert.ok(!allButtons.some(b => b.includes('ড্যাশবোর্ড')));
    assert.ok(allButtons.includes('🟢 অ্যাক্টিভ ইউজার'));
    assert.ok(allButtons.includes('🧹 ক্লিন চ্যাট ও ডাটা'));
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
    assert.equal(normalizeCommandText('/dashboard'), 'active');
    assert.equal(normalizeCommandText('📊 ড্যাশবোর্ড'), 'active');
    assert.equal(normalizeCommandText('/active'), 'active');
    assert.equal(normalizeCommandText('🟢 অ্যাক্টিভ ইউজার'), 'active');
    assert.equal(normalizeCommandText('/previous'), 'previous');
    assert.equal(normalizeCommandText('👥 প্রিভিয়াস ইউজার'), 'previous');
    assert.equal(normalizeCommandText('👥 পূর্ববর্তী ইউজার'), 'previous');
    assert.equal(normalizeCommandText('/history'), 'previous');
    assert.equal(normalizeCommandText('/details'), 'details');
    assert.equal(normalizeCommandText('📋 ইউজার ডিটেইলস'), 'details');
    assert.equal(normalizeCommandText('/clean'), 'clean');
    assert.equal(normalizeCommandText('🧹 ক্লিন চ্যাট ও ডাটা'), 'clean');
    assert.equal(normalizeCommandText('🧹 ক্লিন ড্যাশবোর্ড'), 'clean');
    assert.equal(normalizeCommandText('something-else'), null);
  });

  test('deleteTelegramMessages handles empty or invalid input safely', async () => {
    assert.equal(await deleteTelegramMessages(null, 123, [1, 2]), 0);
    assert.equal(await deleteTelegramMessages('token', null, [1, 2]), 0);
    assert.equal(await deleteTelegramMessages('token', 123, []), 0);
    assert.equal(await deleteTelegramMessages('token', 123, [-5, 'bad']), 0);
  });

  test('deleteTelegramMessages executes bulk deleteMessages and fallback deleteMessage', async () => {
    const fetchCalls = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      fetchCalls.push({ url: String(url), opts });
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    };

    try {
      const count = await deleteTelegramMessages('bot-token', 12345, [101, 102, 103]);
      assert.equal(count, 3);
      assert.ok(fetchCalls.some(c => c.url.includes('deleteMessages')));
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test('clearChatHistory collects tracked IDs and range sweep to delete messages', async () => {
    const fetchCalls = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      fetchCalls.push({ url: String(url), opts });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    };

    const mockRedis = {
      lrange: async () => ['10', '20'],
      del: async () => 1
    };

    try {
      const deleted = await clearChatHistory(mockRedis, 'bot-token', 12345, 50);
      assert.ok(deleted > 0);
      assert.ok(fetchCalls.length > 0);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test('formatDisconnectCard formats detailed card with name, mac, times, duration, and Bengali reason', () => {
    const user = {
      name: 'Rahim Uddin',
      mac: '46:84:b7:da:39:73',
      ip: '192.168.2.155',
      requestedAt: '2026-10-14T12:00:00.000Z'
    };
    const disconnectInfo = {
      mac: '46:84:b7:da:39:73',
      reason: 'timeout_deauth',
      session_start: '2026-10-14T12:00:00.000Z',
      session_end: '2026-10-14T12:30:00.000Z',
      ip: '192.168.2.155'
    };

    const card = formatDisconnectCard(user, disconnectInfo);
    assert.ok(card.includes('🔴 *Wi-Fi Device Disconnected*'));
    assert.ok(card.includes('Rahim Uddin'));
    assert.ok(card.includes('46:84:b7:da:39:73'));
    assert.ok(card.includes('192.168.2.155'));
    assert.ok(card.includes('30 মিনিট'));
    assert.ok(card.includes('⏱ মেয়াদ শেষ (Session Timeout)'));
  });

  test('formatDisconnectCard formats hours and idle timeout reason safely', () => {
    const user = null;
    const disconnectInfo = {
      mac: 'AA:BB:CC:DD:EE:FF',
      reason: 'idle_deauth',
      session_start: '2026-10-14T10:00:00.000Z',
      session_end: '2026-10-14T11:15:00.000Z'
    };

    const card = formatDisconnectCard(user, disconnectInfo);
    assert.ok(card.includes('Guest User'));
    assert.ok(card.includes('aa:bb:cc:dd:ee:ff'));
    assert.ok(card.includes('1 ঘণ্টা 15 মিনিট'));
    assert.ok(card.includes('💤 নিষ্ক্রিয়তা (Idle Timeout)'));
  });

  test('buildUnlimitedKeyboard and buildDefaultAuthKeyboard return valid inline keyboard arrays', () => {
    const unlimKb = buildUnlimitedKeyboard('AA:BB:CC:DD:EE:FF');
    assert.equal(unlimKb.length, 3);
    assert.equal(unlimKb[0][0].callback_data, 'unlim_sess:aa:bb:cc:dd:ee:ff');
    assert.equal(unlimKb[1][0].callback_data, 'unlim_perm:aa:bb:cc:dd:ee:ff');
    assert.equal(unlimKb[2][0].callback_data, 'unlim_back:aa:bb:cc:dd:ee:ff');

    const defaultKb = buildDefaultAuthKeyboard('AA:BB:CC:DD:EE:FF');
    assert.equal(defaultKb.length, 3);
    assert.equal(defaultKb[0][0].callback_data, 'auth:aa:bb:cc:dd:ee:ff:10');
    assert.equal(defaultKb[2][0].callback_data, 'auth:aa:bb:cc:dd:ee:ff:0');
    assert.equal(defaultKb[2][1].callback_data, 'deauth_aa:bb:cc:dd:ee:ff');
  });

  test('buildUnlimitedKeyboard strictly contains NO Chinese characters (永久) and uses 🛡️', () => {
    const kb = buildUnlimitedKeyboard('00:11:22:33:44:55');
    const permButton = kb.find(row => row[0].callback_data.startsWith('unlim_perm:'))[0];
    assert.ok(permButton.text.includes('🛡️'));
    assert.ok(!permButton.text.includes('永久'));
  });

  test('formatSingleActiveUserCard formats detailed card for an individual active user', () => {
    const user = {
      name: 'Tanvir Hossain',
      mac: '46:84:b7:da:39:73',
      ip: '192.168.2.229',
      duration: 30,
      reviewedAt: '2026-10-14T12:00:00.000Z'
    };

    const card = formatSingleActiveUserCard(user);
    assert.ok(card.includes('👤 *ইউজার:* Tanvir Hossain'));
    assert.ok(card.includes('46:84:b7:da:39:73'));
    assert.ok(card.includes('192.168.2.229'));
    assert.ok(card.includes('⏳ 30 মিনিট'));
    assert.ok(card.includes('_সংযোগ বিচ্ছিন্ন করতে নিচের বাটনে চাপ দিন:_'));
    assert.ok(!card.includes('永久'));

    // Permanent user
    const permUser = {
      name: 'Permanent User',
      mac: '06:31:5b:7a:aa:e7',
      ip: '192.168.2.147',
      duration: 0,
      mode: 'permanent'
    };
    const permCard = formatSingleActiveUserCard(permUser);
    assert.ok(permCard.includes('🛡️ স্থায়ী বিশ্বস্ত (Permanent)'));
    assert.ok(!permCard.includes('永久'));

    // Empty user
    assert.equal(formatSingleActiveUserCard(null), '');
  });

  test('buildSingleUserDeauthKeyboard generates a single disconnect button for target user', () => {
    const kb = buildSingleUserDeauthKeyboard('46:84:b7:da:39:73');
    assert.ok(kb && kb.inline_keyboard);
    assert.equal(kb.inline_keyboard.length, 1);
    assert.equal(kb.inline_keyboard[0][0].text, '❌ সংযোগ বিচ্ছিন্ন করুন');
    assert.equal(kb.inline_keyboard[0][0].callback_data, 'deauth_46:84:b7:da:39:73');
  });

  test('deleteTelegramMessage safely deletes message and handles errors', async () => {
    const originalFetch = globalThis.fetch;
    let requestedUrl = null;
    let requestPayload = null;

    globalThis.fetch = async (url, opts) => {
      requestedUrl = String(url);
      requestPayload = JSON.parse(opts.body);
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    };

    try {
      const res = await deleteTelegramMessage('test-token', 12345, 999);
      assert.equal(res, true);
      assert.ok(requestedUrl.includes('deleteMessage'));
      assert.equal(requestPayload.chat_id, 12345);
      assert.equal(requestPayload.message_id, 999);

      // Handles null inputs safely
      assert.equal(await deleteTelegramMessage(null, 123, 456), false);
      assert.equal(await deleteTelegramMessage('token', null, 456), false);
      assert.equal(await deleteTelegramMessage('token', 123, null), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});


