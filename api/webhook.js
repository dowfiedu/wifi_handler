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
  TELEGRAM_MENU_KEYBOARD,
  TELEGRAM_INLINE_MENU,
  fetchUserRecords,
  cleanTerminatedRecords,
  registerBotCommands
} from '../lib/bot-menu.js';

/**
 * Safely parses the callback_data string from Telegram.
 *
 * Formats supported:
 *  - "deauth_<mac>"          -> e.g. "deauth_aa:bb:cc:dd:ee:ff" (Terminate / Disconnect)
 *  - "deauth:<mac>"          -> e.g. "deauth:aa:bb:cc:dd:ee:ff"
 *  - "auth:<mac>:<duration>" -> e.g. "auth:aa:bb:cc:dd:ee:ff:30", "auth:aa:bb:cc:dd:ee:ff:60", "auth:aa:bb:cc:dd:ee:ff:0"
 *  - "auth_<mac>_<duration>" -> e.g. "auth_aa:bb:cc:dd:ee:ff_60", "auth_aa:bb:cc:dd:ee:ff_0"
 *  - "menu_<command>"        -> e.g. "menu_dashboard", "menu_active", "menu_previous", "menu_details", "menu_clean"
 *
 * @param {string} data - Raw callback_data string
 * @returns {{ action: string, mac?: string, duration?: number|null, command?: string } | null}
 */
export function parseCallbackData(data) {
  if (!data || typeof data !== 'string') return null;

  const trimmed = data.trim();

  // 1. Deauth / Terminate action: e.g. "deauth_<mac>" or "deauth:<mac>"
  if (trimmed.startsWith('deauth_') || trimmed.startsWith('deauth:')) {
    const rawMac = trimmed.slice(7).trim();
    const mac = rawMac.toLowerCase().replace(/-/g, ':');
    if (MAC_REGEX.test(mac)) {
      return { action: 'deauth', mac, duration: null };
    }
    return null;
  }

  // 2. Auth action: e.g. "auth:<mac>:<duration>" or "auth_<mac>_<duration>"
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

  // 3. Menu action: e.g. "menu_dashboard", "menu_active", "menu_previous", "menu_details", "menu_clean"
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
export async function sendTelegramMessage(botToken, chatId, text, replyMarkup = null) {
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
    return await res.json().catch(() => null);
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
    // Strip the selection prompt if present
    const cleanBaseText = originalText
      .replace(/\n*Select access duration below to authorize via router:/g, '')
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
 * Dispatches menu actions (Dashboard, Active Users, Previous Users, User Details, Clean Dashboard).
 *
 * @param {string} command - 'dashboard' | 'active' | 'previous' | 'details' | 'clean'
 * @param {object} redis - Redis instance
 * @returns {Promise<{ text: string, replyMarkup: object, ackText?: string }>}
 */
export async function processMenuCommand(command, redis) {
  if (command === 'dashboard') {
    const [users, pendingQueueCount] = await Promise.all([
      fetchUserRecords(redis),
      redis.llen('pending_commands').catch(() => 0)
    ]);
    const activeUsers = users.filter(u => isUserActive(u));
    const text = formatDashboardMessage(activeUsers, Number(pendingQueueCount) || 0);
    return {
      text,
      replyMarkup: TELEGRAM_INLINE_MENU,
      ackText: '📊 ড্যাশবোর্ড আপডেট করা হয়েছে'
    };
  }

  if (command === 'active') {
    const users = await fetchUserRecords(redis);
    const activeUsers = users.filter(u => isUserActive(u));
    const text = formatActiveUsersList(activeUsers);
    return {
      text,
      replyMarkup: TELEGRAM_INLINE_MENU,
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
    return {
      text,
      replyMarkup: TELEGRAM_INLINE_MENU,
      ackText: `📋 ইউজার রেকর্ড: ${users.length} জন`
    };
  }

  if (command === 'clean') {
    const cleanResult = await cleanTerminatedRecords(redis);
    const [users, pendingQueueCount] = await Promise.all([
      fetchUserRecords(redis),
      redis.llen('pending_commands').catch(() => 0)
    ]);
    const activeUsers = users.filter(u => isUserActive(u));
    const dashboardText = formatDashboardMessage(activeUsers, Number(pendingQueueCount) || 0);

    const cleanNotice = [
      '🧹 *ড্যাশবোর্ড সফলভাবে ক্লিন করা হয়েছে!*',
      '━━━━━━━━━━━━━━━━━━━━',
      `✅ মোট *${cleanResult.removedCount}* টি টার্মিনেটেড রেকর্ড ড্যাশবোর্ড থেকে মুছে ফেলা হয়েছে।`,
      'বর্তমানে ড্যাশবোর্ডে শুধুমাত্র সক্রিয় ব্যবহারকারীদের তথ্য রয়েছে।\n'
    ].join('\n');

    return {
      text: `${cleanNotice}\n${dashboardText}`,
      replyMarkup: TELEGRAM_INLINE_MENU,
      ackText: `🧹 ক্লিন সম্পন্ন! (${cleanResult.removedCount} টি রেকর্ড মোছা হয়েছে)`
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
  // Check clean before dashboard so '🧹 ক্লিন ড্যাশবোর্ড' doesn't get matched by generic 'ড্যাশবোর্ড'
  if (['clean', 'ক্লিন', '🧹 ক্লিন ড্যাশবোর্ড'].includes(normalized) || raw.includes('ক্লিন')) {
    return 'clean';
  }
  if (['dashboard', 'ড্যাশবোর্ড', '📊 ড্যাশবোর্ড'].includes(normalized) || raw.includes('ড্যাশবোর্ড')) {
    return 'dashboard';
  }
  if (['active', 'অ্যাক্টিভ', '🟢 অ্যাক্টিভ ইউজার'].includes(normalized) || raw.includes('অ্যাক্টিভ')) {
    return 'active';
  }
  if (['previous', 'history', 'হিস্ট্রি', 'প্রিভিয়াস', '👥 প্রিভিয়াস ইউজার'].includes(normalized) || raw.includes('প্রিভিয়াস') || raw.includes('হিস্ট্রি')) {
    return 'previous';
  }
  if (['details', 'users', 'ডিটেইলস', '📋 ইউজার ডিটেইলস'].includes(normalized) || raw.includes('ডিটেইলস') || raw.includes('বিস্তারিত')) {
    return 'details';
  }
  if (['clean', 'ক্লিন', '🧹 ক্লিন ড্যাশবোর্ড'].includes(normalized) || raw.includes('ক্লিন')) {
    return 'clean';
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

    // Security: Validate authorized chat if TELEGRAM_CHAT_ID is configured in environment
    if (configuredChatId && chatId && String(chatId) !== String(configuredChatId)) {
      await sendTelegramMessage(
        botToken,
        chatId,
        '⛔ *অননুমোদিত প্রবেশাধিকার:* আপনি এই ওয়াইফাই অ্যাডমিন বটের অনুমোদিত অ্যাডমিনিস্ট্রেটর নন।'
      );
      return res.status(200).json({ ok: false, error: 'Unauthorized chat.' });
    }

    const recognizedCommand = normalizeCommandText(message.text);

    if (recognizedCommand === 'menu' && chatId) {
      // Register bot commands asynchronously in background
      registerBotCommands(botToken).catch(() => {});

      const welcomeText = [
        '👋 *স্বাগতম OpenWrt Wi-Fi অ্যাডমিন কন্ট্রোল সেন্টারে!*',
        '━━━━━━━━━━━━━━━━━━━━',
        'এই বটের মাধ্যমে আপনি সরাসরি ওয়াইফাই নেটওয়ার্কের লাইভ ইউজার মনিটর ও কন্ট্রোল করতে পারবেন।',
        '',
        '🔘 *প্রধান কন্ট্রোল অপশনসমূহ:*',
        '• 📊 *ড্যাশবোর্ড:* লাইভ নেটওয়ার্ক ও শুধু অ্যাক্টিভ ইউজারদের স্ট্যাটাস',
        '• 🟢 *অ্যাক্টিভ ইউজার:* বর্তমানে সংযুক্ত ও সক্রিয় ডিভাইস তালিকা',
        '• 👥 *প্রিভিয়াস ইউজার:* পূর্ববর্তী বা মেয়াদোত্তীর্ণ ইউজারদের তালিকা',
        '• 📋 *ইউজার ডিটেইলস:* প্রতিটি ইউজারের পূর্ণ বিবরণ (নাম, তারিখ, MAC, IP ও টাইমস্ট্যাম্প)',
        '• 🧹 *ক্লিন ড্যাশবোর্ড:* টার্মিনেট করা সকল ডিভাইস ড্যাশবোর্ড থেকে অপসারণ',
        '',
        '_নিচের কিবোর্ড বাটন বা কমান্ড সিলেক্ট করে কাজ শুরু করুন।_'
      ].join('\n');

      await sendTelegramMessage(botToken, chatId, welcomeText, TELEGRAM_MENU_KEYBOARD);
      return res.status(200).json({ ok: true, action: 'menu_shown' });
    }

    if (recognizedCommand && chatId) {
      const { text, replyMarkup } = await processMenuCommand(recognizedCommand, redis);
      await sendTelegramMessage(botToken, chatId, text, replyMarkup);
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
    const { text, replyMarkup, ackText } = await processMenuCommand(parsed.command, redis);
    await answerCallbackQuery(botToken, callbackQueryId, ackText || '✅ সম্পন্ন হয়েছে', false);

    if (cbMessage?.chat?.id) {
      // Send fresh response with updated view
      await sendTelegramMessage(botToken, cbMessage.chat.id, text, replyMarkup);
    }
    return res.status(200).json({ ok: true, action: 'menu', command: parsed.command });
  }

  // Handle Client Authorization / Deauthorization actions
  const { action, mac, duration } = parsed;
  let command = '';
  let ackMessage = '';
  let statusNotice = '';
  let inlineKeyboard = [];
  const adminName = from?.first_name || 'Admin';
  const safeAdminName = escapeMarkdown(adminName);

  if (action === 'auth') {
    command = `ndsctl auth ${mac} ${duration}`;
    const durationLabel = duration === 0 ? 'Unlimited' : `${duration}m`;
    ackMessage = `✅ Authorized ${mac} (${durationLabel})`;
    statusNotice = `✅ *Status:* Authorized (${durationLabel}) by ${safeAdminName}`;
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
    inlineKeyboard = []; // Remove buttons once terminated
  }

  try {
    // 1. Push command to FIFO pending_commands queue for OpenWrt router
    await redis.rpush('pending_commands', command);

    // 2. Update request state hash in Redis database
    // Setting status to 'terminated' immediately excludes user from Live Dashboard
    await redis.hset(`request:${mac}`, {
      status: action === 'auth' ? 'authorized' : 'terminated',
      duration: duration ?? 0,
      reviewedBy: adminName,
      reviewedAt: new Date().toISOString()
    });

    // 3. Clear Telegram client spinner
    await answerCallbackQuery(botToken, callbackQueryId, ackMessage, false);

    // 4. Update the original notification message
    await updateTelegramMessage(botToken, cbMessage, statusNotice, inlineKeyboard);

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
