/**
 * /api/webhook.js
 *
 * Telegram Webhook receiver.
 * 1. Listens for `callback_query` updates triggered when an admin clicks inline buttons:
 *    - Authorization duration selection (`auth:<mac>:<duration>`)
 *    - Termination / Deauthentication (`deauth_<mac>`)
 *    - Interactive Menu buttons (`menu_dashboard`, `menu_active`, `menu_previous`, `menu_details`, `menu_clean`)
 * 2. Listens for `message` updates (text commands & persistent menu keyboard buttons):
 *    - /start, /menu
 *    - /dashboard, 📊 ড্যাশবোর্ড
 *    - /active, 🟢 অ্যাক্টিভ ইউজার
 *    - /previous, 👥 প্রিভিয়াস ইউজার
 *    - /details, 📋 ইউজার ডিটেইলস
 *    - /clean, 🧹 ক্লিন ড্যাশবোর্ড
 */

import { Redis } from '@upstash/redis';
import { escapeMarkdown } from './request.js';
import {
  MAC_REGEX,
  isUserActive,
  formatUserDetailsList,
  formatActiveUsersList,
  formatPreviousUsersList,
  formatDashboardMessage,
  buildActiveUsersKeyboard,
  buildDefaultAuthKeyboard,
  buildUnlimitedKeyboard,
  TELEGRAM_MENU_KEYBOARD,
  TELEGRAM_INLINE_MENU,
  fetchUserRecords,
  cleanTerminatedRecords,
  registerBotCommands,
  trackChatMessage,
  clearChatHistory
} from '../lib/bot-menu.js';

/**
 * Safely parses the callback_data string from Telegram.
 *
 * Formats supported:
 *  - "deauth_<mac>"          -> e.g. "deauth_aa:bb:cc:dd:ee:ff" (Terminate / Disconnect)
 *  - "deauth:<mac>"          -> e.g. "deauth:aa:bb:cc:dd:ee:ff"
 *  - "auth:<mac>:<duration>" -> e.g. "auth:aa:bb:cc:dd:ee:ff:30", "auth:aa:bb:cc:dd:ee:ff:60", "auth:aa:bb:cc:dd:ee:ff:0"
 *  - "auth_<mac>_<duration>" -> e.g. "auth_aa:bb:cc:dd:ee:ff_60", "auth_aa:bb:cc:dd:ee:ff_0"
 *  - "unlim_sess:<mac>"      -> e.g. "unlim_sess:aa:bb:cc:dd:ee:ff" (Session Unlimited)
 *  - "unlim_perm:<mac>"      -> e.g. "unlim_perm:aa:bb:cc:dd:ee:ff" (Permanent Trusted)
 *  - "unlim_back:<mac>"      -> e.g. "unlim_back:aa:bb:cc:dd:ee:ff" (Cancel unlimited menu)
 *  - "menu_<command>"        -> e.g. "menu_dashboard", "menu_active", "menu_previous", "menu_details", "menu_clean"
 *
 * @param {string} data - Raw callback_data string
 * @returns {{ action: string, mac?: string, duration?: number|null, mode?: string, command?: string } | null}
 */
export function parseCallbackData(data) {
  if (!data || typeof data !== 'string') return null;

  const trimmed = data.trim();

  // 1. Unlimited sub-actions
  if (trimmed.startsWith('unlim_sess:') || trimmed.startsWith('unlim_sess_')) {
    const rawMac = trimmed.slice(11).trim();
    const mac = rawMac.toLowerCase().replace(/-/g, ':');
    if (MAC_REGEX.test(mac)) {
      return { action: 'unlim_sess', mac, duration: 0, mode: 'session' };
    }
    return null;
  }

  if (trimmed.startsWith('unlim_perm:') || trimmed.startsWith('unlim_perm_')) {
    const rawMac = trimmed.slice(11).trim();
    const mac = rawMac.toLowerCase().replace(/-/g, ':');
    if (MAC_REGEX.test(mac)) {
      return { action: 'unlim_perm', mac, duration: 0, mode: 'permanent' };
    }
    return null;
  }

  if (trimmed.startsWith('unlim_back:') || trimmed.startsWith('unlim_back_')) {
    const rawMac = trimmed.slice(11).trim();
    const mac = rawMac.toLowerCase().replace(/-/g, ':');
    if (MAC_REGEX.test(mac)) {
      return { action: 'unlim_back', mac, duration: null };
    }
    return null;
  }

  // 2. Deauth / Terminate action: e.g. "deauth_<mac>" or "deauth:<mac>"
  if (trimmed.startsWith('deauth_') || trimmed.startsWith('deauth:')) {
    const rawMac = trimmed.slice(7).trim();
    const mac = rawMac.toLowerCase().replace(/-/g, ':');
    if (MAC_REGEX.test(mac)) {
      return { action: 'deauth', mac, duration: null };
    }
    return null;
  }

  // 3. Auth action: e.g. "auth:<mac>:<duration>" or "auth_<mac>_<duration>"
  if (trimmed.startsWith('auth:') || trimmed.startsWith('auth_')) {
    const rest = trimmed.slice(5).trim();
    const lastSep = Math.max(rest.lastIndexOf(':'), rest.lastIndexOf('_'));
    if (lastSep === -1) return null;

    const rawMac = rest.slice(0, lastSep).trim();
    const durationStr = rest.slice(lastSep + 1).trim();
    const mac = rawMac.toLowerCase().replace(/-/g, ':');
    const duration = parseInt(durationStr, 10);

    if (isNaN(duration) || duration < 0 || !MAC_REGEX.test(mac)) {
      return null;
    }

    return { action: 'auth', mac, duration };
  }

  // 4. Menu action: e.g. "menu_dashboard", "menu_active", "menu_previous", "menu_details", "menu_clean"
  if (trimmed.startsWith('menu_') || trimmed.startsWith('menu:')) {
    const rawCmd = trimmed.slice(5).trim().toLowerCase();
    const normalizedCmd = rawCmd === 'history' ? 'previous' : (rawCmd === 'users' ? 'details' : rawCmd);
    if (['dashboard', 'active', 'previous', 'details', 'clean'].includes(normalizedCmd)) {
      return { action: 'menu', command: normalizedCmd };
    }
    return null;
  }

  return null;
}

/**
 * Converts Bengali numerical digits (০-৯) to standard Arabic digits (0-9).
 *
 * @param {string} str
 * @returns {string}
 */
export function normalizeDigits(str) {
  if (!str) return '';
  const bnDigits = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯'];
  return str.replace(/[০-৯]/g, d => bnDigits.indexOf(d).toString());
}

/**
 * Parses duration in minutes from user text.
 * Supports digits, units (m, min, mins, minute, minutes, h, hr, hours, মিনিট, মিনিটের, মি, ঘন্টা, ঘণ্টা),
 * Bengali numerals, and conversational suffixes (সময়, সময়, এক্সেস, দাও, দেন, এর জন্য).
 *
 * Returns:
 *  - number >= 0 (minutes, 0 = unlimited)
 *  - -1 (rejection / cancel)
 *  - null (not a recognized duration)
 *
 * @param {string} text
 * @returns {number|null}
 */
export function parseDurationString(text) {
  if (!text || typeof text !== 'string') return null;
  const raw = normalizeDigits(text.trim());
  const cleaned = raw
    .replace(/[।!?~:;\-_ঃ,]+/g, ' ')
    .replace(/(?<!\d)\.|\.(?!\d)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return null;

  // 1. Unlimited
  if (/^(?:unlimited|unlimit|0|স্থায়ী|আনলিমিটেড|ইনফিনিটি|♾)$/i.test(cleaned) || /^\/unlimited$/i.test(cleaned)) {
    return 0;
  }

  // 2. Rejection / Cancel
  if (/^(?:reject|cancel|deauth|kick|no|বাতিল|না|❌)$/i.test(cleaned) || /^\/(?:reject|deauth|cancel)$/i.test(cleaned)) {
    return -1;
  }

  // 3. Hours: e.g. "1h", "2 hrs", "1 hour", "1.5h", "২ ঘন্টা", "১ ঘণ্টা", "১ ঘণ্টা সময়"
  const hourMatch = cleaned.match(/^(?:\/auth\s+)?(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours|ঘণ্টা|ঘন্টা|ঘন্টার|ঘণ্টার)(?:\s*(?:সময়|সময়|এক্সেস|access|এর\s*জন্য|জন্য|দাও|দেন))?$/i);
  if (hourMatch) {
    const hours = parseFloat(hourMatch[1]);
    if (!isNaN(hours) && hours > 0) {
      return Math.round(hours * 60);
    }
  }

  // 4. Minutes: e.g. "1", "15", "10m", "20 mins", "1 minute", "১ মিনিট", "১ মিনিট সময়", "১ মিনিটের জন্য", "১মি"
  const minMatch = cleaned.match(/^(?:\/auth\s+)?(\d+)(?:\s*(?:m|min|mins|minute|minutes|মিনিট|মিনিটের|মি))?(?:\s*(?:সময়|সময়|এক্সেস|access|দাও|দেন|এর\s*জন্য|জন্য))?$/i);
  if (minMatch) {
    const duration = parseInt(minMatch[1], 10);
    if (!isNaN(duration) && duration >= 0) {
      return duration;
    }
  }

  return null;
}

/**
 * Parses custom authorization commands or reply-to-message minutes from Telegram text.
 * Supports:
 *  - Direct commands: "/auth <mac> <duration>", "/auth <mac>", "/deauth <mac>"
 *  - Reply to request cards with minutes: "1", "15", "10m", "20 mins", "১ মিনিট", "১মিনিট", "১ মিনিট সময়", "১৫"
 *  - Reply to request cards with hours: "1h", "2h", "1.5h", "1 hour", "২ ঘন্টা"
 *  - Reply to request cards with reject: "reject", "cancel", "deauth", "বাতিল", "না", "❌"
 *  - Reply to request cards with unlimited: "0", "unlimited", "স্থায়ী", "আনলিমিটেড", "♾"
 *  - Messages with duration only (mac will be null, allowing automatic resolution from pending queue)
 *
 * @param {string} text - User message text
 * @param {string} [replyToText] - Text of the message being replied to (if any)
 * @returns {{ action: 'auth'|'deauth', mac: string|null, duration?: number|null } | null}
 */
export function parseCustomAuthMessage(text, replyToText = null) {
  if (!text || typeof text !== 'string') return null;
  const rawTrimmed = text.trim();
  const trimmed = normalizeDigits(rawTrimmed);

  // 1. Direct command: /auth <mac> [duration] or /deauth <mac>
  const directAuth = trimmed.match(/^\/(?:auth|approve)\s+((?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2})(?:\s+(\d+))?/i);
  if (directAuth) {
    const mac = directAuth[1].toLowerCase().replace(/-/g, ':');
    const duration = directAuth[2] !== undefined ? parseInt(directAuth[2], 10) : 60;
    return { action: 'auth', mac, duration };
  }

  const directDeauth = trimmed.match(/^\/(?:deauth|reject|kick)\s+((?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2})/i);
  if (directDeauth) {
    const mac = directDeauth[1].toLowerCase().replace(/-/g, ':');
    return { action: 'deauth', mac, duration: null };
  }

  // Extract MAC from reply-to-message if present
  let mac = null;
  if (replyToText && typeof replyToText === 'string') {
    const macMatch = replyToText.match(/([0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}/);
    if (macMatch) {
      mac = macMatch[0].toLowerCase().replace(/-/g, ':');
    }
  }

  // Check specific permanent / session keywords
  const isPermanent = /^(?:permanent|trust|trusted|স্থায়ী|স্থায়ী|বিশ্বস্ত|লগইন ছাড়া|লগইন ছাড়া)$/i.test(trimmed) || /^\/(?:trust|permanent)$/i.test(trimmed);
  const isSession = /^(?:session|এককালীন|একবার)$/i.test(trimmed) || /^\/session$/i.test(trimmed);

  if (isPermanent) {
    return { action: 'auth', mac, duration: 0, mode: 'permanent' };
  }
  if (isSession) {
    return { action: 'auth', mac, duration: 0, mode: 'session' };
  }

  // 2. Parse duration value from text
  const durationValue = parseDurationString(text);
  if (durationValue === null) {
    return null;
  }

  if (durationValue === -1) {
    return { action: 'deauth', mac, duration: null };
  }

  return { action: 'auth', mac, duration: durationValue };
}

/**
 * Helper to answer Telegram callback query to dismiss the loading spinner on Telegram UI.
 */
export async function answerCallbackQuery(botToken, callbackQueryId, text, showAlert = false) {
  if (!botToken || !callbackQueryId) return;
  try {
    const url = `https://api.telegram.org/bot${botToken}/answerCallbackQuery`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        callback_query_id: callbackQueryId,
        text,
        show_alert: showAlert
      })
    });
  } catch (err) {
    console.error('[answerCallbackQuery Failed]', err);
  }
}

/**
 * Helper to send a new message to a Telegram chat.
 */
export async function sendTelegramMessage(botToken, chatId, text, replyMarkup = null, redis = null) {
  if (!botToken || !chatId) return null;
  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const payload = {
      chat_id: chatId,
      text,
      parse_mode: 'Markdown'
    };
    if (replyMarkup) {
      payload.reply_markup = replyMarkup;
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const resData = await res.json().catch(() => null);
    if (resData?.ok && resData?.result?.message_id && redis) {
      trackChatMessage(redis, chatId, resData.result.message_id).catch(() => {});
    }
    return resData;
  } catch (err) {
    console.error('[sendTelegramMessage Failed]', err);
    return null;
  }
}

/**
 * Helper to update original Telegram message to reflect the chosen action.
 * Attaches a "❌ Terminate" button when authorized so admins can instantly revoke access.
 */
export async function updateTelegramMessage(botToken, message, statusText, inlineKeyboard = []) {
  if (!message || !message.chat || !message.message_id) return;

  try {
    const originalText = message.text || '';
    // Strip the selection prompt and any prior status line if present
    const cleanBaseText = originalText
      .replace(/\n*Select (?:access )?duration below[^\n]*/gi, '')
      .replace(/\n*Select (?:unlimited )?access mode below[^\n]*/gi, '')
      .replace(/\n*♾.*?[\s\S]*?(?:মোড নির্বাচন করুন:_|$)/gi, '')
      .replace(/\n*(?:✅|❌)\s*\*?Status:\*?[^\n]*/gi, '')
      .trim();

    // Escape Markdown special characters in the base text to prevent Telegram parser errors
    const escapedBase = escapeMarkdown(cleanBaseText);
    const updatedText = `${escapedBase}\n\n${statusText}`;
    const url = `https://api.telegram.org/bot${botToken}/editMessageText`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: message.chat.id,
        message_id: message.message_id,
        text: updatedText,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: inlineKeyboard }
      })
    });

    const data = await res.json().catch(() => null);
    if (!res.ok || (data && !data.ok)) {
      console.warn('[updateTelegramMessage Warning]', data?.description || res.statusText);
    }
  } catch (err) {
    console.error('[updateTelegramMessage Failed]', err);
  }
}

/**
 * Directly edits the message text and inline keyboard in-place.
 */
export async function editTelegramMessageText(botToken, chatId, messageId, text, inlineKeyboard = []) {
  if (!botToken || !chatId || !messageId) return;
  try {
    const url = `https://api.telegram.org/bot${botToken}/editMessageText`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: inlineKeyboard }
      })
    });
  } catch (err) {
    console.error('[editTelegramMessageText Failed]', err);
  }
}

/**
 * Dispatches menu actions (Active Users, Previous Users, User Details, Clean Dashboard/Chat).
 * Redundant dashboard is merged directly into the active users view.
 *
 * @param {string} command - 'active' | 'previous' | 'details' | 'clean' | 'dashboard'
 * @param {object} redis - Redis instance
 * @param {string} [botToken] - Telegram Bot Token
 * @param {string|number} [chatId] - Telegram Chat ID
 * @param {number} [currentMsgId] - Current Telegram message ID triggering the action
 * @returns {Promise<{ text: string, replyMarkup: object, ackText?: string }>}
 */
export async function processMenuCommand(command, redis, botToken = null, chatId = null, currentMsgId = null) {
  // Active users view (and dashboard redirection)
  if (command === 'active' || command === 'dashboard') {
    const [users, pendingQueueCount] = await Promise.all([
      fetchUserRecords(redis),
      redis.llen('pending_commands').catch(() => 0)
    ]);
    const activeUsers = users.filter(u => isUserActive(u));
    const text = formatActiveUsersList(activeUsers, Number(pendingQueueCount) || 0);
    const activeKeyboard = buildActiveUsersKeyboard(activeUsers);

    return {
      text,
      replyMarkup: activeKeyboard || TELEGRAM_INLINE_MENU,
      ackText: `🟢 অ্যাক্টিভ ইউজার: ${activeUsers.length} জন`
    };
  }

  if (command === 'previous') {
    const users = await fetchUserRecords(redis);
    const previousUsers = users.filter(u => !isUserActive(u) && u.status !== 'pending');
    const text = formatPreviousUsersList(previousUsers);
    return {
      text,
      replyMarkup: TELEGRAM_INLINE_MENU,
      ackText: `👥 পূর্ববর্তী ইউজার: ${previousUsers.length} জন`
    };
  }

  if (command === 'details') {
    const users = await fetchUserRecords(redis);
    const text = formatUserDetailsList(users);
    const activeUsers = users.filter(u => isUserActive(u));
    const activeKeyboard = buildActiveUsersKeyboard(activeUsers);

    return {
      text,
      replyMarkup: activeKeyboard || TELEGRAM_INLINE_MENU,
      ackText: `📋 ইউজার রেকর্ড: ${users.length} জন`
    };
  }

  if (command === 'clean') {
    // 1. Wipe previous chat conversation history from Telegram
    if (botToken && chatId) {
      await clearChatHistory(redis, botToken, chatId, currentMsgId);
    }

    // 2. Clean terminated database records
    const cleanResult = await cleanTerminatedRecords(redis);
    const [users, pendingQueueCount] = await Promise.all([
      fetchUserRecords(redis),
      redis.llen('pending_commands').catch(() => 0)
    ]);
    const activeUsers = users.filter(u => isUserActive(u));

    const cleanNotice = [
      '🧹 *ক্লিন অপারেশন সফলভাবে সম্পন্ন!*',
      '━━━━━━━━━━━━━━━━━━━━',
      '🗑 *চ্যাট হিস্ট্রি:* পূর্ববর্তী সকল বার্তা মুছে দেওয়া হয়েছে।',
      `🗄 *ডাটাবেজ:* ${cleanResult.removedCount} টি টার্মিনেটেড রেকর্ড অপসারণ করা হয়েছে।`,
      `🟢 *বর্তমান সক্রিয় ইউজার:* ${activeUsers.length} জন`,
      `⏳ *পেন্ডিং রাউটার কিউ:* ${Number(pendingQueueCount) || 0} টি`,
      '━━━━━━━━━━━━━━━━━━━━',
      '✨ আপনার কন্ট্রোল প্যানেল এখন সম্পূর্ণ পরিচ্ছন্ন ও প্রস্তুত।',
      '_নিচের মেনুবার থেকে যেকোনো অপশন বেছে নিন।_'
    ].join('\n');

    return {
      text: cleanNotice,
      replyMarkup: TELEGRAM_MENU_KEYBOARD,
      ackText: '🧹 ক্লিন সম্পন্ন! চ্যাট ও ডাটা ফ্রেশ করা হয়েছে'
    };
  }

  return {
    text: 'ℹ️ কমান্ডটি খুঁজে পাওয়া যায়নি। অনুগ্রহ করে মেনু থেকে নির্বাচন করুন।',
    replyMarkup: TELEGRAM_INLINE_MENU
  };
}

/**
 * Normalizes text input to a known command string.
 *
 * @param {string} text
 * @returns {string|null}
 */
export function normalizeCommandText(text) {
  if (!text || typeof text !== 'string') return null;
  const raw = text.trim().toLowerCase();

  // Strip leading slash if any
  const normalized = raw.startsWith('/') ? raw.slice(1).trim() : raw;

  if (['start', 'menu', 'help', 'মেনু', 'সাহায্য'].includes(normalized)) {
    return 'menu';
  }
  // Check clean before other keywords
  if (['clean', 'ক্লিন', '🧹 ক্লিন চ্যাট ও ডাটা', '🧹 ক্লিন ড্যাশবোর্ড'].includes(normalized) || raw.includes('ক্লিন')) {
    return 'clean';
  }
  // Gracefully redirect legacy dashboard to active view
  if (['dashboard', 'ড্যাশবোর্ড', '📊 ড্যাশবোর্ড'].includes(normalized) || raw.includes('ড্যাশবোর্ড')) {
    return 'active';
  }
  if (['active', 'অ্যাক্টিভ', '🟢 অ্যাক্টিভ ইউজার'].includes(normalized) || raw.includes('অ্যাক্টিভ')) {
    return 'active';
  }
  if (['previous', 'history', 'হিস্ট্রি', 'প্রিভিয়াস', 'পূর্ববর্তী', '👥 পূর্ববর্তী ইউজার', '👥 প্রিভিয়াস ইউজার'].includes(normalized) || raw.includes('প্রিভিয়াস') || raw.includes('পূর্ববর্তী') || raw.includes('হিস্ট্রি')) {
    return 'previous';
  }
  if (['details', 'users', 'ডিটেইলস', 'বিস্তারিত', '📋 ইউজার ডিটেইলস'].includes(normalized) || raw.includes('ডিটেইলস') || raw.includes('বিস্তারিত')) {
    return 'details';
  }

  return null;
}

/**
 * Vercel Serverless Function Handler
 */
export default async function handler(req, res) {
  // Telegram webhooks send POST requests
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed. Use POST.' });
  }

  // Parse request body
  let update = req.body;
  if (typeof update === 'string') {
    try {
      update = JSON.parse(update);
    } catch {
      return res.status(400).json({ error: 'Malformed JSON update payload.' });
    }
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!botToken || !redisUrl || !redisToken) {
    console.error('[Config Error] Missing TELEGRAM_BOT_TOKEN or UPSTASH credentials in environment.');
    return res.status(500).json({ error: 'Server configuration error.' });
  }

  const redis = new Redis({
    url: redisUrl,
    token: redisToken
  });

  const callbackQuery = update?.callback_query;
  const message = update?.message;
  const configuredChatId = process.env.TELEGRAM_CHAT_ID;

  // ---------------------------------------------------------------------------
  // 1. Process Telegram Messages (Text commands & Persistent Reply Keyboard)
  // ---------------------------------------------------------------------------
  if (message && message.text) {
    const chatId = message.chat?.id;
    const currentMsgId = message.message_id;

    // Track user message in Redis so it can be purged during Clean Dashboard
    if (chatId && currentMsgId) {
      trackChatMessage(redis, chatId, currentMsgId).catch(() => {});
    }

    // Security: Validate authorized chat if TELEGRAM_CHAT_ID is configured in environment
    if (configuredChatId && chatId && String(chatId) !== String(configuredChatId)) {
      await sendTelegramMessage(
        botToken,
        chatId,
        '⛔ *অননুমোদিত প্রবেশাধিকার:* আপনি এই ওয়াইফাই অ্যাডমিন বটের অনুমোদিত অ্যাডমিনিস্ট্রেটর নন।'
      );
      return res.status(200).json({ ok: false, error: 'Unauthorized chat.' });
    }

    // 1.1 Process custom duration authorization or rejection (direct command or reply-to-card)
    const customAuth = parseCustomAuthMessage(message.text, message.reply_to_message?.text);
    if (customAuth) {
      let { action, mac, duration } = customAuth;

      // Auto-resolve target MAC from Redis pending queue if message was not a direct command or reply
      if (!mac) {
        try {
          const pendingMacs = await redis.lrange('pending_macs', -1, -1);
          if (pendingMacs && pendingMacs.length > 0 && MAC_REGEX.test(pendingMacs[0])) {
            mac = pendingMacs[0].toLowerCase().replace(/-/g, ':');
          } else {
            const users = await fetchUserRecords(redis);
            const pendingUser = users.find(u => String(u.status).toLowerCase() === 'pending');
            if (pendingUser && pendingUser.mac) {
              mac = pendingUser.mac.toLowerCase().replace(/-/g, ':');
            }
          }
        } catch (dbErr) {
          console.warn('[Pending MAC Lookup Error]', dbErr);
        }
      }

      // If MAC could still not be resolved, send helpful guidance immediately
      if (!mac) {
        const durationPrompt = duration === null ? 'বাতিল' : (duration === 0 ? 'আনলিমিটেড' : `${duration} মিনিট`);
        const helpMsg = [
          `ℹ️ *কাকে অনুমোদন দিতে চান তা নির্দিষ্ট করা যায়নি (${durationPrompt})।*`,
          '━━━━━━━━━━━━━━━━━━━━',
          'আপনি যে ইউজারকে অনুমোদন দিতে চান তার কার্ড মেসেজটিতে *Reply* করে সময় লিখুন, অথবা সরাসরি কমান্ড লিখুন:',
          '`/auth <MAC> <মিনিট>` (যেমন: `/auth 46:84:b7:da:39:73 15`)'
        ].join('\n');
        await sendTelegramMessage(botToken, chatId, helpMsg, null, redis);
        return res.status(200).json({ ok: false, error: 'Target MAC could not be resolved.' });
      }

      // If duration === 0 and mode is not specified (e.g. user typed "unlimited" or "0" or "আনলিমিটেড"):
      // Prompt with the 2 unlimited options:
      if (action === 'auth' && duration === 0 && !customAuth.mode) {
        const modePrompt = [
          '♾ *আনলিমিটেড অ্যাক্সেস মোড নির্ধারণ করুন:*',
          `🏷 *ডিভাইস MAC:* \`${mac}\``,
          '━━━━━━━━━━━━━━━━━━━━',
          'নিচের কোন মোডে ইউজারকে আনলিমিটেড অ্যাক্সেস দিতে চান?',
          '• *🔄 এককালীন:* এই সেশনের জন্য আনলিমিটেড, কিন্তু সংযোগ বিচ্ছিন্ন হলে আবার লগইন পেজ আসবে।',
          '• *永久 স্থায়ী বিশ্বস্ত:* রাউটারে বিশ্বস্ত হিসেবে সংরক্ষিত থাকবে, লগইন পেজ আর কখনোই আসবে না।'
        ].join('\n');

        await sendTelegramMessage(
          botToken,
          chatId,
          modePrompt,
          { inline_keyboard: buildUnlimitedKeyboard(mac) },
          redis
        );
        return res.status(200).json({ ok: true, action: 'unlimited_prompt_sent', mac });
      }

      const adminName = message.from?.first_name || 'Admin';
      const safeAdminName = escapeMarkdown(adminName);
      let command = '';
      let statusNotice = '';
      let inlineKeyboard = [];
      let confirmText = '';
      const mode = customAuth.mode;

      if (action === 'auth') {
        if (mode === 'permanent') {
          command = `ndsctl trust ${mac}`;
          statusNotice = `✅ *Status:* Authorized (永久 স্থায়ী বিশ্বস্ত / Permanent Trusted) by ${safeAdminName}`;
          confirmText = `✅ *অনুমোদন সম্পন্ন:* \`${mac}\` কে *স্থায়ী বিশ্বস্ত (Permanent Trusted)* তালিকায় যুক্ত করা হয়েছে। (লগইন পেজ আর কখনোই আসবে না)`;
        } else if (duration === 0) {
          command = `ndsctl auth ${mac} 0`;
          statusNotice = `✅ *Status:* Authorized (♾ এককালীন / Session Unlimited) by ${safeAdminName}`;
          confirmText = `✅ *অনুমোদন সম্পন্ন:* \`${mac}\` কে *এককালীন আনলিমিটেড* এক্সেস দেওয়া হয়েছে। (ডিসকানেক্ট হলে আবার লগইন পেজ আসবে)`;
        } else {
          command = `ndsctl auth ${mac} ${duration}`;
          statusNotice = `✅ *Status:* Authorized (${duration}m) by ${safeAdminName}`;
          confirmText = `✅ *অনুমোদন সম্পন্ন:* \`${mac}\` কে ${duration} মিনিটের জন্য এক্সেস অনুমোদন দেওয়া হয়েছে এবং রাউটার কিউতে পাঠানো হয়েছে।`;
        }
        inlineKeyboard = [
          [
            { text: '❌ Terminate', callback_data: `deauth_${mac}` }
          ]
        ];
      } else {
        command = `ndsctl deauth ${mac}`;
        statusNotice = `❌ *Status:* Terminated / Revoked by ${safeAdminName}`;
        confirmText = `❌ *সংযোগ বিচ্ছিন্ন:* \`${mac}\` এর এক্সেস বাতিল করা হয়েছে।`;
        inlineKeyboard = [];
      }

      try {
        // 1. Push command to pending_commands queue for OpenWrt router
        await redis.rpush('pending_commands', command);

        // 2. Update request state hash in Redis database
        await redis.hset(`request:${mac}`, {
          status: action === 'auth' ? 'authorized' : 'terminated',
          duration: duration ?? 0,
          mode: mode || (duration === 0 ? 'session' : 'timed'),
          trusted: mode === 'permanent' ? 'true' : 'false',
          reviewedBy: adminName,
          reviewedAt: new Date().toISOString()
        });

        // 3. Update original message if this was a reply to a notification card
        if (message.reply_to_message) {
          await updateTelegramMessage(botToken, message.reply_to_message, statusNotice, inlineKeyboard);
        }

        // 4. Send confirmation message to admin chat
        await sendTelegramMessage(botToken, chatId, confirmText, null, redis);

        return res.status(200).json({
          ok: true,
          action,
          mac,
          duration,
          mode: mode || null,
          commandQueued: command
        });
      } catch (err) {
        console.error('[Custom Auth Queue Error]', err);
        await sendTelegramMessage(
          botToken,
          chatId,
          '⚠️ রাউটার কিউতে কমান্ড যোগ করতে সমস্যা হয়েছে। অনুগ্রহ করে আবার চেষ্টা করুন।'
        );
        return res.status(500).json({ error: 'Failed to push command to Redis queue.' });
      }
    }

    const recognizedCommand = normalizeCommandText(message.text);

    if (recognizedCommand === 'menu' && chatId) {
      // Register bot commands asynchronously in background
      registerBotCommands(botToken).catch(() => {});

      const welcomeText = [
        '👋 *স্বাগতম OpenWrt Wi-Fi অ্যাডমিন কন্ট্রোল সেন্টারে!*',
        '━━━━━━━━━━━━━━━━━━━━',
        'এই বটের মাধ্যমে আপনি সরাসরি ওয়াইফাই নেটওয়ার্কের লাইভ ইউজার মনিটর ও সংযোগ নিয়ন্ত্রণ করতে পারবেন।',
        '',
        '🔘 *প্রধান কন্ট্রোল অপশনসমূহ:*',
        '• 🟢 *অ্যাক্টিভ ইউজার:* সংযুক্ত সক্রিয় ডিভাইস ও সরাসরি টার্মিনেশন বাটন',
        '• 👥 *পূর্ববর্তী ইউজার:* পূর্ববর্তী বা মেয়াদোত্তীর্ণ ইউজারদের তালিকা',
        '• 📋 *ইউজার ডিটেইলস:* প্রতিটি ইউজারের পূর্ণ বিবরণ (নাম, তারিখ, MAC, IP ও টাইমস্ট্যাম্প)',
        '• 🧹 *ক্লিন চ্যাট ও ডাটা:* টার্মিনেট করা সকল ডিভাইস ও পূর্ববর্তী চ্যাট বার্তা অপসারণ',
        '',
        '_নিচের স্থায়ী মেনুবার থেকে যেকোনো অপশন বেছে নিন।_'
      ].join('\n');

      await sendTelegramMessage(botToken, chatId, welcomeText, TELEGRAM_MENU_KEYBOARD, redis);
      return res.status(200).json({ ok: true, action: 'menu_shown' });
    }

    if (recognizedCommand && chatId) {
      const { text, replyMarkup } = await processMenuCommand(
        recognizedCommand,
        redis,
        botToken,
        chatId,
        currentMsgId
      );
      await sendTelegramMessage(botToken, chatId, text, replyMarkup, redis);
      return res.status(200).json({ ok: true, command: recognizedCommand });
    }

    // Unrecognized text message fallback (acknowledge without error to maintain webhook health)
    return res.status(200).json({
      ok: true,
      message: 'No callback query or recognized command to process.'
    });
  }

  // ---------------------------------------------------------------------------
  // 2. Process Telegram Callback Queries (Inline Button Clicks)
  // ---------------------------------------------------------------------------
  if (!callbackQuery) {
    return res.status(200).json({
      ok: true,
      message: 'No callback query or recognized command to process.'
    });
  }

  const { id: callbackQueryId, data, message: cbMessage, from } = callbackQuery;
  const cbChatId = cbMessage?.chat?.id;

  // Security: Restrict callback query actions to authorized administrator chat
  if (configuredChatId && cbChatId && String(cbChatId) !== String(configuredChatId)) {
    await answerCallbackQuery(botToken, callbackQueryId, '⛔ Unauthorized access.', true);
    return res.status(200).json({ ok: false, error: 'Unauthorized callback.' });
  }

  const parsed = parseCallbackData(data);

  if (!parsed) {
    await answerCallbackQuery(
      botToken,
      callbackQueryId,
      '❌ Error: Invalid or unrecognized button action.',
      true
    );
    return res.status(200).json({ ok: true, error: 'Unrecognized callback action format.' });
  }

  // Handle Menu callbacks: "menu_dashboard", "menu_active", "menu_previous", "menu_details", "menu_clean"
  if (parsed.action === 'menu') {
    const currentMsgId = cbMessage?.message_id;
    const { text, replyMarkup, ackText } = await processMenuCommand(
      parsed.command,
      redis,
      botToken,
      cbChatId,
      currentMsgId
    );
    await answerCallbackQuery(botToken, callbackQueryId, ackText || '✅ সম্পন্ন হয়েছে', false);

    if (cbChatId) {
      // Send fresh response with updated view
      await sendTelegramMessage(botToken, cbChatId, text, replyMarkup, redis);
    }
    return res.status(200).json({ ok: true, action: 'menu', command: parsed.command });
  }

  // Handle Unlimited sub-mode prompting and switching
  if (parsed.action === 'auth' && parsed.duration === 0) {
    await answerCallbackQuery(botToken, callbackQueryId, '♾ আনলিমিটেড মোড নির্বাচন করুন', false);
    const unlimKeyboard = buildUnlimitedKeyboard(parsed.mac);
    const modePrompt = '♾ *আনলিমিটেড অ্যাক্সেস মোড নির্ধারণ করুন:*\n• *এককালীন:* সংযোগ বিচ্ছিন্ন হলে পরবর্তী বার আবার লগইন পেজ আসবে\n• *স্থায়ী বিশ্বস্ত:* লগইন পেজ আর কখনোই আসবে না\n\n_নিচের যেকোনো একটি মোড নির্বাচন করুন:_';
    await updateTelegramMessage(botToken, cbMessage, modePrompt, unlimKeyboard);
    return res.status(200).json({ ok: true, action: 'unlimited_menu_prompted', mac: parsed.mac });
  }

  if (parsed.action === 'unlim_back') {
    await answerCallbackQuery(botToken, callbackQueryId, '🔙 পূর্বের অপশনে ফিরে যাওয়া হয়েছে', false);
    const defaultKeyboard = buildDefaultAuthKeyboard(parsed.mac);
    const defaultPrompt = 'Select duration below or reply with custom minutes (e.g. 15):';
    await updateTelegramMessage(botToken, cbMessage, defaultPrompt, defaultKeyboard);
    return res.status(200).json({ ok: true, action: 'unlimited_menu_cancelled', mac: parsed.mac });
  }

  // Handle Client Authorization / Deauthorization / Unlimited Sub-actions
  const { action, mac, duration, mode } = parsed;
  let command = '';
  let ackMessage = '';
  let statusNotice = '';
  let confirmText = '';
  let inlineKeyboard = [];
  const adminName = from?.first_name || 'Admin';
  const safeAdminName = escapeMarkdown(adminName);

  if (action === 'unlim_perm') {
    command = `ndsctl trust ${mac}`;
    ackMessage = `✅ স্থায়ী বিশ্বস্ত অনুমোদিত (${mac})`;
    statusNotice = `✅ *Status:* Authorized (永久 স্থায়ী বিশ্বস্ত / Permanent Trusted) by ${safeAdminName}`;
    confirmText = `✅ *অনুমোদন সম্পন্ন:* \`${mac}\` কে *স্থায়ী বিশ্বস্ত (Permanent Trusted)* তালিকায় যুক্ত করা হয়েছে। (লগইন পেজ আর কখনোই আসবে না)`;
    inlineKeyboard = [
      [
        { text: '❌ Terminate', callback_data: `deauth_${mac}` }
      ]
    ];
  } else if (action === 'unlim_sess') {
    command = `ndsctl auth ${mac} 0`;
    ackMessage = `✅ এককালীন আনলিমিটেড অনুমোদিত (${mac})`;
    statusNotice = `✅ *Status:* Authorized (♾ এককালীন / Session Unlimited) by ${safeAdminName}`;
    confirmText = `✅ *অনুমোদন সম্পন্ন:* \`${mac}\` কে *এককালীন আনলিমিটেড* এক্সেস দেওয়া হয়েছে। (ডিসকানেক্ট হলে আবার লগইন পেজ আসবে)`;
    inlineKeyboard = [
      [
        { text: '❌ Terminate', callback_data: `deauth_${mac}` }
      ]
    ];
  } else if (action === 'auth') {
    command = `ndsctl auth ${mac} ${duration}`;
    const durationLabel = `${duration}m`;
    ackMessage = `✅ Authorized ${mac} (${durationLabel})`;
    statusNotice = `✅ *Status:* Authorized (${durationLabel}) by ${safeAdminName}`;
    confirmText = `✅ *অনুমোদন সম্পন্ন:* \`${mac}\` কে ${duration} মিনিটের জন্য এক্সেস অনুমোদন দেওয়া হয়েছে।`;
    // Attach "❌ Terminate" button so admin can revoke anytime
    inlineKeyboard = [
      [
        { text: '❌ Terminate', callback_data: `deauth_${mac}` }
      ]
    ];
  } else if (action === 'deauth') {
    command = `ndsctl deauth ${mac}`;
    ackMessage = `❌ Terminated ${mac}`;
    statusNotice = `❌ *Status:* Terminated / Revoked by ${safeAdminName}`;
    confirmText = `❌ *সংযোগ বিচ্ছিন্ন:* \`${mac}\` এর এক্সেস বাতিল করা হয়েছে।`;
    inlineKeyboard = []; // Remove buttons once terminated
  }

  try {
    // 1. Push command to FIFO pending_commands queue for OpenWrt router
    await redis.rpush('pending_commands', command);

    // 2. Update request state hash in Redis database
    // Setting status to 'terminated' immediately excludes user from Live Dashboard
    const userUpdate = {
      status: action === 'deauth' ? 'terminated' : 'authorized',
      duration: duration ?? 0,
      mode: (action === 'unlim_perm' ? 'permanent' : (action === 'unlim_sess' ? 'session' : (mode || (duration === 0 ? 'session' : 'timed')))),
      trusted: action === 'unlim_perm' ? 'true' : 'false',
      reviewedBy: adminName,
      reviewedAt: new Date().toISOString()
    };
    await redis.hset(`request:${mac}`, userUpdate);

    // 3. Clear Telegram client spinner
    await answerCallbackQuery(botToken, callbackQueryId, ackMessage, false);

    // 4. Update the original notification message or refresh active users list in-place
    if (action === 'deauth' && cbMessage?.text && (cbMessage.text.includes('সক্রিয়') || cbMessage.text.includes('Active'))) {
      const [updatedUsers, pendingQueue] = await Promise.all([
        fetchUserRecords(redis),
        redis.llen('pending_commands').catch(() => 0)
      ]);
      const updatedActive = updatedUsers.filter(u => isUserActive(u));
      const updatedText = formatActiveUsersList(updatedActive, Number(pendingQueue) || 0);
      const updatedKeyboard = buildActiveUsersKeyboard(updatedActive);
      await editTelegramMessageText(
        botToken,
        cbChatId,
        cbMessage.message_id,
        updatedText,
        updatedKeyboard ? updatedKeyboard.inline_keyboard : []
      );
    } else {
      await updateTelegramMessage(botToken, cbMessage, statusNotice, inlineKeyboard);
    }

    // 5. Send confirmation message to admin chat for unlimited sub-actions
    if ((action === 'unlim_perm' || action === 'unlim_sess') && cbChatId) {
      await sendTelegramMessage(botToken, cbChatId, confirmText, null, redis);
    }

    return res.status(200).json({
      ok: true,
      action,
      mac,
      commandQueued: command
    });
  } catch (error) {
    console.error('[Webhook Queue Exception]', error);

    await answerCallbackQuery(
      botToken,
      callbackQueryId,
      '⚠️ Error queuing command in Redis. Please try again.',
      true
    );

    return res.status(500).json({
      error: 'Failed to push command to Redis queue.'
    });
  }
}
