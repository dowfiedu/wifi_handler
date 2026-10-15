/**
 * lib/bot-menu.js
 *
 * Core helper utilities for Telegram Bot interactive menu,
 * dashboard views, user history categorization, and database cleanup.
 */

import { escapeMarkdown } from '../api/request.js';

/**
 * Valid MAC address regex
 */
export const MAC_REGEX = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i;

/**
 * Application default timezone (defaults to Asia/Dhaka for Bangladesh local time)
 */
export const APP_TIMEZONE = process.env.TIMEZONE || 'Asia/Dhaka';

/**
 * Formats an ISO timestamp into separate human-friendly Date and Time components.
 * Defaults to Bangladesh Standard Time (Asia/Dhaka - BST).
 *
 * @param {string|number|Date} isoString
 * @param {string} [timeZone]
 * @returns {{ date: string, time: string, rawDate: Date|null }}
 */
export function formatDateTime(isoString, timeZone = APP_TIMEZONE) {
  if (!isoString) {
    return { date: 'N/A', time: 'N/A', rawDate: null };
  }
  const dateObj = new Date(isoString);
  if (isNaN(dateObj.getTime())) {
    return { date: 'N/A', time: 'N/A', rawDate: null };
  }

  const tz = timeZone || APP_TIMEZONE || 'Asia/Dhaka';

  const dateStr = dateObj.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: tz
  }); // e.g. "13 Oct 2026"

  const timeStr = dateObj.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
    timeZone: tz
  }) + (tz === 'Asia/Dhaka' ? ' BST' : ''); // e.g. "06:10:18 PM BST"

  return { date: dateStr, time: timeStr, rawDate: dateObj };
}

/**
 * Determines whether a user record is currently active and within its granted duration.
 *
 * @param {object} user
 * @returns {boolean}
 */
export function isUserActive(user) {
  if (!user || typeof user !== 'object') return false;
  const status = String(user.status || '').toLowerCase();
  const isAuth = status === 'authorized' || status === 'authenticated';
  if (!isAuth) return false;

  const duration = Number(user.duration);
  // duration === 0 denotes unlimited access
  if (duration === 0) return true;

  if (duration > 0 && user.reviewedAt) {
    const reviewedTime = new Date(user.reviewedAt).getTime();
    if (!isNaN(reviewedTime)) {
      const elapsedMs = Date.now() - reviewedTime;
      const durationMs = duration * 60 * 1000;
      if (elapsedMs > durationMs) {
        return false; // naturally expired
      }
    }
  }

  return true;
}

/**
 * Checks if a user has been terminated or rejected.
 *
 * @param {object} user
 * @returns {boolean}
 */
export function isUserTerminated(user) {
  if (!user || typeof user !== 'object') return false;
  const status = String(user.status || '').toLowerCase();
  return status === 'terminated' || status === 'rejected';
}

/**
 * Formats a single user details card in the exact format requested:
 * 1. Name
 * 2. Date
 * 3. MAC address
 * 4. IP address
 * 5. Timestamp
 *
 * @param {object} user
 * @returns {string}
 */
export function formatUserDetailsCard(user) {
  const timestampField = user.requestedAt || user.reviewedAt || user.authenticatedAt || new Date().toISOString();
  const { date, time } = formatDateTime(timestampField);

  const safeName = escapeMarkdown(user.name || 'Guest User');
  const safeMac = user.mac ? user.mac.toLowerCase() : 'N/A';
  const safeIp = escapeMarkdown(user.ip || 'N/A');

  const status = String(user.status || '').toLowerCase();
  let statusBadge = '⏳ অপেক্ষমান (Pending)';
  if (isUserActive(user)) {
    statusBadge = '🟢 সক্রিয় (Active)';
  } else if (status === 'terminated') {
    statusBadge = '❌ টার্মিনেটেড (Terminated)';
  } else if (status === 'rejected') {
    statusBadge = '🚫 বাতিলকৃত (Rejected)';
  } else if (status === 'authorized' || status === 'authenticated') {
    statusBadge = '⏱ মেয়াদোত্তীর্ণ (Expired)';
  }

  return [
    `👤 *নাম:* ${safeName}`,
    `📅 *তারিখ:* ${date}`,
    `🏷 *ম্যাক অ্যাড্রেস:* \`${safeMac}\``,
    `🌐 *আইপি অ্যাড্রেস:* \`${safeIp}\``,
    `⏰ *টাইমস্ট্যাম্প:* ${time}`,
    `📌 *স্ট্যাটাস:* ${statusBadge}`
  ].join('\n');
}

/**
 * Formats the full list of all user details cards.
 *
 * @param {Array<object>} users
 * @returns {string}
 */
export function formatUserDetailsList(users) {
  if (!users || users.length === 0) {
    return [
      '📋 *সমস্ত ইউজারদের বিস্তারিত তথ্য*',
      '━━━━━━━━━━━━━━━━━━━━',
      'ℹ️ বর্তমানে কোনো ইউজারের রেকর্ড পাওয়া যায়নি।'
    ].join('\n');
  }

  const header = `📋 *সমস্ত ইউজারদের বিস্তারিত তথ্য (মোট: ${users.length} জন)*\n━━━━━━━━━━━━━━━━━━━━`;
  // Limit to most recent 25 to prevent hitting Telegram's 4096 character limit
  const visible = users.slice(0, 25);
  const cards = visible.map(u => formatUserDetailsCard(u));
  let result = `${header}\n${cards.join('\n━━━━━━━━━━━━━━━━━━━━\n')}`;

  if (users.length > 25) {
    result += `\n━━━━━━━━━━━━━━━━━━━━\n_... এবং আরও ${users.length - 25} জন ইউজার তালিকায় রয়েছে।_`;
  }
  return result;
}

/**
 * Builds inline keyboard buttons to terminate/deauthenticate active users.
 *
 * @param {Array<object>} activeUsers
 * @returns {object|null}
 */
export function buildDefaultAuthKeyboard(mac) {
  const cleanMac = (mac || '').toLowerCase().replace(/-/g, ':');
  return [
    [
      { text: '⏱ 10 Mins', callback_data: `auth:${cleanMac}:10` },
      { text: '⏱ 15 Mins', callback_data: `auth:${cleanMac}:15` },
      { text: '⏱ 20 Mins', callback_data: `auth:${cleanMac}:20` }
    ],
    [
      { text: '⏱ 30 Mins', callback_data: `auth:${cleanMac}:30` },
      { text: '⏱ 1 Hour', callback_data: `auth:${cleanMac}:60` }
    ],
    [
      { text: '♾ Unlimited', callback_data: `auth:${cleanMac}:0` },
      { text: '❌ Reject', callback_data: `deauth_${cleanMac}` }
    ]
  ];
}

/**
 * Builds inline keyboard for choosing unlimited sub-options:
 * 1. Session Unlimited (Re-login on next visit / disconnect)
 * 2. Permanent Trusted (Bypasses captive portal permanently)
 * 3. Back button (Restores standard duration keyboard)
 *
 * @param {string} mac
 * @returns {Array<Array<object>>}
 */
export function buildUnlimitedKeyboard(mac) {
  const cleanMac = (mac || '').toLowerCase().replace(/-/g, ':');
  return [
    [{ text: '🔄 এককালীন (পরের বার লগইন পেজ আসবে)', callback_data: `unlim_sess:${cleanMac}` }],
    [{ text: '🛡️ স্থায়ী বিশ্বস্ত (লগইন পেজ আর আসবে না)', callback_data: `unlim_perm:${cleanMac}` }],
    [{ text: '🔙 ফিরে যান', callback_data: `unlim_back:${cleanMac}` }]
  ];
}

/**
 * Builds a single-button inline keyboard to terminate/deauthenticate an active user.
 *
 * @param {string} mac
 * @returns {object}
 */
export function buildSingleUserDeauthKeyboard(mac) {
  const cleanMac = (mac || '').toLowerCase().replace(/-/g, ':');
  return {
    inline_keyboard: [
      [
        { text: '❌ সংযোগ বিচ্ছিন্ন করুন', callback_data: `deauth_${cleanMac}` }
      ]
    ]
  };
}

/**
 * Formats a standalone detailed card for an individual active Wi-Fi user.
 *
 * @param {object} user
 * @returns {string}
 */
export function formatSingleActiveUserCard(user) {
  if (!user) return '';
  const duration = Number(user.duration);
  let durationLabel = 'N/A';
  if (duration === 0) {
    if (user.mode === 'permanent' || user.trusted === 'true' || user.trusted === true) {
      durationLabel = '🛡️ স্থায়ী বিশ্বস্ত (Permanent)';
    } else {
      durationLabel = '♾️ এককালীন (Unlimited)';
    }
  } else if (duration > 0) {
    durationLabel = `⏳ ${duration} মিনিট`;
  }
  const { time, date } = formatDateTime(user.reviewedAt || user.authenticatedAt || user.requestedAt);
  const safeName = escapeMarkdown(user.name || 'Guest User');
  const safeIp = escapeMarkdown(user.ip || 'N/A');
  const safeMac = escapeMarkdown(user.mac || 'N/A');

  return [
    `👤 *ইউজার:* ${safeName}`,
    '━━━━━━━━━━━━━━━━━━━━',
    `🏷 *MAC অ্যাড্রেস:* \`${safeMac}\``,
    `🌐 *IP অ্যাড্রেস:* \`${safeIp}\``,
    `⏱ *অনুমোদিত মেয়াদ:* ${durationLabel}`,
    `⏰ *কানেক্টেড সময়:* ${time} (${date})`,
    '━━━━━━━━━━━━━━━━━━━━',
    '_সংযোগ বিচ্ছিন্ন করতে নিচের বাটনে চাপ দিন:_'
  ].join('\n');
}

/**
 * Builds inline keyboard buttons to terminate/deauthenticate active users.
 *
 * @param {Array<object>} activeUsers
 * @returns {object|null}
 */
export function buildActiveUsersKeyboard(activeUsers = []) {
  if (!Array.isArray(activeUsers) || activeUsers.length === 0) {
    return null;
  }

  const buttons = activeUsers.slice(0, 10).map(u => {
    const rawName = (u.name || 'User').trim();
    const shortName = rawName.length > 15 ? rawName.slice(0, 14) + '…' : rawName;
    return [{
      text: `❌ সংযোগ বিচ্ছিন্ন: ${shortName}`,
      callback_data: `deauth_${u.mac}`
    }];
  });

  return { inline_keyboard: buttons };
}

/**
 * Formats the active users list with count, network stats, and details.
 *
 * @param {Array<object>} activeUsers
 * @param {number} pendingQueueCount
 * @returns {string}
 */
export function formatActiveUsersList(activeUsers = [], pendingQueueCount = 0) {
  const count = Array.isArray(activeUsers) ? activeUsers.length : 0;
  const tz = APP_TIMEZONE || 'Asia/Dhaka';
  const now = new Date().toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
    timeZone: tz
  }) + (tz === 'Asia/Dhaka' ? ' BST' : '');

  let msg = [
    '🟢 *সক্রিয় নেটওয়ার্ক ইউজার (Active Wi-Fi Users)*',
    '━━━━━━━━━━━━━━━━━━━━',
    `📊 *নেটওয়ার্ক স্ট্যাটাস:* 🟢 সচল | *পেন্ডিং কিউ:* ${pendingQueueCount} টি`,
    `👥 *মোট কানেক্টেড ইউজার:* ${count} জন`,
    `⏰ *সর্বশেষ লাইভ আপডেট:* ${now}`,
    '━━━━━━━━━━━━━━━━━━━━'
  ].join('\n');

  if (count === 0) {
    msg += '\n\nℹ️ বর্তমানে কোনো ইউজার অ্যাক্টিভ বা কানেক্টেড নেই।\nনতুন রিকোয়েস্ট এলে অনুমোদন করতে পারবেন।';
    return msg;
  }

  msg += '\n\n';
  activeUsers.forEach((u, i) => {
    const duration = Number(u.duration);
    let durationLabel = 'N/A';
    if (duration === 0) {
      if (u.mode === 'permanent' || u.trusted === 'true' || u.trusted === true) {
        durationLabel = '🛡️ স্থায়ী বিশ্বস্ত';
      } else {
        durationLabel = '♾ এককালীন';
      }
    } else if (duration > 0) {
      durationLabel = `${duration}m`;
    }
    const { time } = formatDateTime(u.reviewedAt || u.authenticatedAt || u.requestedAt);
    const safeName = escapeMarkdown(u.name || 'Guest User');
    const safeIp = escapeMarkdown(u.ip || 'N/A');

    msg += `${i + 1}. *${safeName}*\n   ├ 🏷 MAC: \`${u.mac}\`\n   ├ 🌐 IP: \`${safeIp}\`\n   ├ ⏱ মেয়াদ: ${durationLabel}\n   └ ⏰ কানেক্টেড: ${time}\n\n`;
  });

  msg += '━━━━━━━━━━━━━━━━━━━━\n_💡 যেকোনো অ্যাক্টিভ ইউজারকে টার্মিনেট করতে নিচের লাল বাটন প্রেস করুন:_';

  return msg.trim();
}

/**
 * Formats the previous/history users list.
 *
 * @param {Array<object>} previousUsers
 * @returns {string}
 */
export function formatPreviousUsersList(previousUsers) {
  const count = Array.isArray(previousUsers) ? previousUsers.length : 0;
  let msg = [
    '👥 *প্রিভিয়াস ইউজারদের তালিকা (Previous Users)*',
    '━━━━━━━━━━━━━━━━━━━━',
    `📁 *মোট পূর্ববর্তী ইউজার:* ${count} জন\n`
  ].join('\n');

  if (count === 0) {
    msg += '\nℹ️ কোনো পূর্ববর্তী ইউজারের হিস্ট্রি পাওয়া যায়নি।';
    return msg;
  }

  // Show up to 25 records
  const visible = previousUsers.slice(0, 25);
  visible.forEach((u, i) => {
    const { date, time } = formatDateTime(u.reviewedAt || u.requestedAt);
    const status = String(u.status || '').toLowerCase();
    const statusBadge = status === 'terminated'
      ? '❌ Terminated'
      : (status === 'rejected' ? '🚫 Rejected' : '⏱ Expired');
    const safeName = escapeMarkdown(u.name || 'Guest User');

    msg += `${i + 1}. *${safeName}*\n   🏷 MAC: \`${u.mac}\` | ${statusBadge}\n   📅 সেশন: ${date} (${time})\n\n`;
  });

  if (previousUsers.length > 25) {
    msg += `_... এবং আরও ${previousUsers.length - 25} জন হিস্ট্রিতে রয়েছে।_`;
  }

  return msg.trim();
}

/**
 * Formats the Live Dashboard view.
 * Kept for backwards compatibility; unifies into the active users view.
 *
 * @param {Array<object>} activeUsers
 * @param {number} pendingQueueCount
 * @returns {string}
 */
export function formatDashboardMessage(activeUsers = [], pendingQueueCount = 0) {
  return formatActiveUsersList(activeUsers, pendingQueueCount);
}

/**
 * Persistent Telegram Reply Keyboard (always pinned at the bottom of the chat).
 * High-priority action at top, followed by 2x2 grid layout with is_persistent: true.
 */
export const TELEGRAM_MENU_KEYBOARD = {
  keyboard: [
    [{ text: '➕ ম্যাক অথোরাইজ' }],
    [{ text: '🟢 অ্যাক্টিভ ইউজার' }, { text: '👥 পূর্ববর্তী ইউজার' }],
    [{ text: '📋 ইউজার ডিটেইলস' }, { text: '🧹 ক্লিন চ্যাট ও ডাটা' }]
  ],
  resize_keyboard: true,
  is_persistent: true
};

/**
 * Inline menu keyboard with callback triggers.
 */
export const TELEGRAM_INLINE_MENU = {
  inline_keyboard: [
    [
      { text: '➕ ম্যাক অথোরাইজ', callback_data: 'menu_auth' }
    ],
    [
      { text: '🟢 অ্যাক্টিভ ইউজার', callback_data: 'menu_active' },
      { text: '👥 পূর্ববর্তী ইউজার', callback_data: 'menu_previous' }
    ],
    [
      { text: '📋 ইউজার ডিটেইলস', callback_data: 'menu_details' },
      { text: '🧹 ক্লিন চ্যাট ও ডাটা', callback_data: 'menu_clean' }
    ]
  ]
};

/**
 * Fetches all unique user records from Redis (both hash records and chronological history).
 *
 * @param {object} redis - Upstash Redis instance
 * @returns {Promise<Array<object>>}
 */
export async function fetchUserRecords(redis) {
  if (!redis) return [];

  try {
    const rawHistory = await redis.lrange('request_history', 0, 99);
    const parsedItems = [];
    const seenMacs = new Set();

    if (Array.isArray(rawHistory)) {
      for (const item of rawHistory) {
        try {
          const entry = typeof item === 'string' ? JSON.parse(item) : item;
          if (entry && entry.mac && !seenMacs.has(entry.mac)) {
            seenMacs.add(entry.mac);
            parsedItems.push(entry);
          }
        } catch {
          // Skip corrupt JSON
        }
      }
    }

    if (parsedItems.length === 0) return [];

    // Pipeline batch fetch if supported to minimize round-trip network latency
    let batchHashes = null;
    if (typeof redis.pipeline === 'function') {
      try {
        const pipe = redis.pipeline();
        for (const entry of parsedItems) {
          pipe.hgetall(`request:${entry.mac}`);
        }
        batchHashes = await pipe.exec();
      } catch {
        batchHashes = null;
      }
    }

    // Enhance each record with the most up-to-date Redis hash values
    const users = await Promise.all(
      parsedItems.map(async (entry, idx) => {
        try {
          const hash = (batchHashes && batchHashes[idx])
            ? batchHashes[idx]
            : await redis.hgetall(`request:${entry.mac}`);

          return {
            name: hash?.name || entry.name || 'Guest User',
            mac: entry.mac,
            ip: hash?.ip || entry.ip || '',
            status: hash?.status || entry.status || 'pending',
            duration: hash?.duration !== undefined ? Number(hash.duration) : (entry.duration ? Number(entry.duration) : null),
            requestedAt: entry.requestedAt || hash?.requestedAt || null,
            reviewedAt: hash?.reviewedAt || entry.reviewedAt || null,
            authenticatedAt: hash?.authenticatedAt || entry.authenticatedAt || null,
            reviewedBy: hash?.reviewedBy || entry.reviewedBy || null
          };
        } catch {
          return entry;
        }
      })
    );

    return users;
  } catch (err) {
    console.error('[fetchUserRecords Error]', err);
    return [];
  }
}

/**
 * Cleans terminated and rejected user records from Upstash Redis:
 * - Deletes `request:<mac>` hashes for terminated users
 * - Removes terminated entries from `request_history`
 *
 * @param {object} redis - Upstash Redis instance
 * @returns {Promise<{ removedCount: number, remainingCount: number }>}
 */
export async function cleanTerminatedRecords(redis) {
  if (!redis) return { removedCount: 0, remainingCount: 0 };

  try {
    const rawHistory = await redis.lrange('request_history', 0, 499);
    if (!Array.isArray(rawHistory) || rawHistory.length === 0) {
      return { removedCount: 0, remainingCount: 0 };
    }

    const cleanedHistory = [];
    const terminatedMacs = new Set();

    for (const item of rawHistory) {
      try {
        const entry = typeof item === 'string' ? JSON.parse(item) : item;
        if (!entry || !entry.mac) continue;

        // Check hash or entry status
        const hash = await redis.hgetall(`request:${entry.mac}`).catch(() => null);
        const status = String(hash?.status || entry.status || '').toLowerCase();

        if (status === 'terminated' || status === 'rejected') {
          terminatedMacs.add(entry.mac);
        } else {
          cleanedHistory.push(JSON.stringify(entry));
        }
      } catch {
        // Skip malformed entries
      }
    }

    // Parallel deletion of terminated MAC hashes
    if (terminatedMacs.size > 0) {
      const deletePromises = Array.from(terminatedMacs).map(mac =>
        redis.del(`request:${mac}`).catch(() => {})
      );
      await Promise.all(deletePromises);
    }

    // Replace request_history with the cleaned history
    await redis.del('request_history');
    if (cleanedHistory.length > 0) {
      await redis.rpush('request_history', ...cleanedHistory);
    }

    return {
      removedCount: terminatedMacs.size,
      remainingCount: cleanedHistory.length
    };
  } catch (err) {
    console.error('[cleanTerminatedRecords Error]', err);
    return { removedCount: 0, remainingCount: 0 };
  }
}

/**
 * Registers Telegram Bot Commands so the client Menu button displays them with descriptions.
 *
 * @param {string} botToken
 */
export async function registerBotCommands(botToken) {
  if (!botToken) return;
  try {
    const commandsUrl = `https://api.telegram.org/bot${botToken}/setMyCommands`;
    await fetch(commandsUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commands: [
          { command: 'menu', description: 'প্রধান কন্ট্রোল মেনুবার' },
          { command: 'auth', description: 'সরাসরি MAC এড্রেস অনুমোদন' },
          { command: 'active', description: 'সক্রিয় ইউজার তালিকা ও টার্মিনেশন' },
          { command: 'previous', description: 'পূর্ববর্তী ইউজারদের তালিকা' },
          { command: 'details', description: 'ইউজারদের পূর্ণাঙ্গ বিবরণ (নাম, তারিখ, IP, MAC)' },
          { command: 'clean', description: 'চ্যাট হিস্ট্রি ও ডাটা সম্পূর্ণ ক্লিন' }
        ]
      })
    });

    // Configure the Telegram native Menu button to show commands
    const menuButtonUrl = `https://api.telegram.org/bot${botToken}/setChatMenuButton`;
    await fetch(menuButtonUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        menu_button: { type: 'commands' }
      })
    });
  } catch (err) {
    console.warn('[registerBotCommands Warning]', err);
  }
}

/**
 * Tracks a Telegram message ID in Redis so it can be purged during chat cleanup.
 *
 * @param {object} redis
 * @param {string|number} chatId
 * @param {number} messageId
 */
export async function trackChatMessage(redis, chatId, messageId) {
  if (!redis || !chatId || !messageId) return;
  try {
    const key = `telegram_messages:${chatId}`;
    await redis.rpush(key, messageId);
    await redis.ltrim(key, -200, -1);
  } catch {}
}

/**
 * Deletes a list of messages from a Telegram chat.
 * Tries the bulk deleteMessages endpoint first; falls back to individual deleteMessage calls.
 *
 * @param {string} botToken
 * @param {string|number} chatId
 * @param {Array<number>} messageIds
 * @returns {Promise<number>} Number of message IDs attempted
 */
export async function deleteTelegramMessages(botToken, chatId, messageIds) {
  if (!botToken || !chatId || !Array.isArray(messageIds) || messageIds.length === 0) {
    return 0;
  }

  const validIds = Array.from(new Set(
    messageIds
      .map(id => parseInt(id, 10))
      .filter(id => !isNaN(id) && id > 0)
  ));

  if (validIds.length === 0) return 0;

  // Process in chunks of up to 100
  const chunkSize = 100;
  let totalProcessed = 0;

  for (let i = 0; i < validIds.length; i += chunkSize) {
    const chunk = validIds.slice(i, i + chunkSize);
    let bulkSuccess = false;

    try {
      const url = `https://api.telegram.org/bot${botToken}/deleteMessages`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          message_ids: chunk
        })
      });
      const data = await res.json().catch(() => null);
      if (data && data.ok) {
        bulkSuccess = true;
        totalProcessed += chunk.length;
      }
    } catch {}

    // Fallback: If bulk deletion fails or is partially restricted, delete individually
    if (!bulkSuccess) {
      await Promise.allSettled(
        chunk.map(async (msgId) => {
          try {
            await fetch(`https://api.telegram.org/bot${botToken}/deleteMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: chatId,
                message_id: msgId
              })
            });
            totalProcessed++;
          } catch {}
        })
      );
    }
  }

  return totalProcessed;
}

/**
 * Deletes a single message from Telegram chat.
 *
 * @param {string} botToken
 * @param {string|number} chatId
 * @param {number} messageId
 * @returns {Promise<boolean>}
 */
export async function deleteTelegramMessage(botToken, chatId, messageId) {
  if (!botToken || !chatId || !messageId) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/deleteMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId
      })
    });
    const data = await res.json().catch(() => null);
    return Boolean(data && data.ok);
  } catch {
    return false;
  }
}

/**
 * Erases previous bot chat conversation history:
 * Combines explicit Redis message IDs and a backward sweep from currentMessageId.
 *
 * @param {object} redis
 * @param {string} botToken
 * @param {string|number} chatId
 * @param {number} [currentMessageId]
 * @returns {Promise<number>}
 */
export async function clearChatHistory(redis, botToken, chatId, currentMessageId = null) {
  if (!botToken || !chatId) return 0;

  const idsToDelete = new Set();

  // 1. Collect all message IDs recorded in Redis
  if (redis) {
    try {
      const key = `telegram_messages:${chatId}`;
      const stored = await redis.lrange(key, 0, -1);
      if (Array.isArray(stored)) {
        stored.forEach(id => {
          const num = parseInt(id, 10);
          if (!isNaN(num) && num > 0) idsToDelete.add(num);
        });
      }
      // Purge tracked list in Redis
      await redis.del(key);
    } catch {}
  }

  // 2. If currentMessageId is provided, sweep previous 80 message IDs in the chat
  if (currentMessageId) {
    const numCurrent = parseInt(currentMessageId, 10);
    if (!isNaN(numCurrent) && numCurrent > 0) {
      const sweepRange = 80;
      const startId = Math.max(1, numCurrent - sweepRange);
      for (let id = startId; id <= numCurrent; id++) {
        idsToDelete.add(id);
      }
    }
  }

  const idsArray = Array.from(idsToDelete);
  if (idsArray.length === 0) return 0;

  return await deleteTelegramMessages(botToken, chatId, idsArray);
}

/**
 * Formats a disconnect / session-expired feedback card for Telegram.
 * Localizes timestamps to Bangladesh Time (Asia/Dhaka BST).
 *
 * @param {object|null} user - User record from Redis
 * @param {object} disconnectInfo - Details of the disconnect event (mac, reason, session_start, session_end, ip)
 * @returns {string} - Markdown formatted Telegram message
 */
export function formatDisconnectCard(user, disconnectInfo = {}) {
  const name = user?.name || 'Guest User';
  const mac = (user?.mac || disconnectInfo.mac || 'N/A').toLowerCase();
  const ip = user?.ip || disconnectInfo.ip || null;
  const connectedIso = user?.authorizedAt || user?.requestedAt || disconnectInfo.session_start;
  const disconnectedIso = disconnectInfo.disconnectedAt || disconnectInfo.session_end || new Date().toISOString();

  const startFormatted = formatDateTime(connectedIso);
  const endFormatted = formatDateTime(disconnectedIso);

  // Compute total duration used
  let durationText = 'N/A';
  if (startFormatted.rawDate && endFormatted.rawDate) {
    const diffMs = Math.max(0, endFormatted.rawDate.getTime() - startFormatted.rawDate.getTime());
    const totalMinutes = Math.max(1, Math.round(diffMs / 60000));
    if (totalMinutes >= 60) {
      const hours = Math.floor(totalMinutes / 60);
      const mins = totalMinutes % 60;
      durationText = mins > 0 ? `${hours} ঘণ্টা ${mins} মিনিট` : `${hours} ঘণ্টা`;
    } else {
      durationText = `${totalMinutes} মিনিট`;
    }
  }

  // Human-friendly reason in Bengali
  let reasonText = '⏱ মেয়াদ শেষ (Session Timeout)';
  const rawReason = String(disconnectInfo.reason || '').toLowerCase();
  if (rawReason.includes('timeout') && !rawReason.includes('idle')) {
    reasonText = '⏱ মেয়াদ শেষ (Session Timeout)';
  } else if (rawReason.includes('idle')) {
    reasonText = '💤 নিষ্ক্রিয়তা (Idle Timeout)';
  } else if (rawReason.includes('downquota') || rawReason.includes('upquota')) {
    reasonText = '📊 ডাটা কোটা শেষ (Quota Exceeded)';
  } else if (rawReason.includes('client') || rawReason.includes('manual') || rawReason.includes('terminate') || rawReason.includes('deauth')) {
    reasonText = '❌ সংযোগ বিচ্ছিন্ন (Admin Terminated)';
  } else if (rawReason) {
    reasonText = `⚠️ ${rawReason}`;
  }

  const lines = [
    '🔴 *Wi-Fi Device Disconnected*',
    '━━━━━━━━━━━━━━━━━━━━',
    `👤 *User:* ${escapeMarkdown(name)}`,
    `🏷 *MAC:* \`${mac}\``,
    ip ? `🌐 *IP:* \`${escapeMarkdown(ip)}\`` : null,
    `⏰ *কানেক্ট হয়েছিল:* ${startFormatted.date}, ${startFormatted.time}`,
    `🛑 *ডিসকানেক্ট হয়েছে:* ${endFormatted.date}, ${endFormatted.time}`,
    `⌛ *মোট ব্যবহার:* ${durationText}`,
    `📌 *কারণ:* ${reasonText}`,
    '━━━━━━━━━━━━━━━━━━━━'
  ].filter(Boolean);

  return lines.join('\n');
}

