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
 * Formats an ISO timestamp into separate human-friendly Date and Time components.
 *
 * @param {string|number|Date} isoString
 * @returns {{ date: string, time: string, rawDate: Date|null }}
 */
export function formatDateTime(isoString) {
  if (!isoString) {
    return { date: 'N/A', time: 'N/A', rawDate: null };
  }
  const dateObj = new Date(isoString);
  if (isNaN(dateObj.getTime())) {
    return { date: 'N/A', time: 'N/A', rawDate: null };
  }

  const dateStr = dateObj.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC'
  }); // e.g. "13 Oct 2026"

  const timeStr = dateObj.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
    timeZone: 'UTC'
  }) + ' UTC'; // e.g. "05:10:18 PM UTC"

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

  return [
    `👤 *নাম:* ${safeName}`,
    `📅 *তারিখ:* ${date}`,
    `🏷 *ম্যাক অ্যাড্রেস:* \`${safeMac}\``,
    `🌐 *আইপি অ্যাড্রেস:* \`${safeIp}\``,
    `⏰ *টাইমস্ট্যাম্প:* ${time}`
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
 * Formats the active users list with count and details.
 *
 * @param {Array<object>} activeUsers
 * @returns {string}
 */
export function formatActiveUsersList(activeUsers) {
  const count = Array.isArray(activeUsers) ? activeUsers.length : 0;
  let msg = [
    '🟢 *বর্তমানে অ্যাক্টিভ ইউজারগণ (Active Users)*',
    '━━━━━━━━━━━━━━━━━━━━',
    `👥 *মোট কানেক্টেড ইউজার:* ${count} জন\n`
  ].join('\n');

  if (count === 0) {
    msg += '\nℹ️ বর্তমানে কোনো ইউজার অ্যাক্টিভ বা কানেক্টেড নেই।';
    return msg;
  }

  activeUsers.forEach((u, i) => {
    const duration = Number(u.duration);
    const durationLabel = duration === 0 ? '♾ Unlimited' : (duration > 0 ? `${duration}m` : 'N/A');
    const { time } = formatDateTime(u.reviewedAt || u.authenticatedAt || u.requestedAt);
    const safeName = escapeMarkdown(u.name || 'Guest User');
    const safeIp = escapeMarkdown(u.ip || 'N/A');

    msg += `${i + 1}. *${safeName}*\n   🏷 MAC: \`${u.mac}\`\n   🌐 IP: \`${safeIp}\`\n   ⏱ মেয়াদ: ${durationLabel} | ⏰ কানেক্টেড: ${time}\n\n`;
  });

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
 * IMPORTANT: Terminated users are strictly omitted from the dashboard view.
 * Only currently active users are presented.
 *
 * @param {Array<object>} activeUsers
 * @param {number} pendingQueueCount
 * @returns {string}
 */
export function formatDashboardMessage(activeUsers = [], pendingQueueCount = 0) {
  const now = new Date().toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
    timeZone: 'UTC'
  }) + ' UTC';

  let msg = [
    '📊 *ওয়াইফাই নেটওয়ার্ক ড্যাশবোর্ড (Live Dashboard)*',
    '━━━━━━━━━━━━━━━━━━━━',
    `🟢 *কারেন্টলি অ্যাক্টিভ ইউজার:* ${activeUsers.length} জন`,
    `⏳ *পেন্ডিং রাউটার কিউ:* ${pendingQueueCount} টি`,
    `⏰ *সর্বশেষ লাইভ আপডেট:* ${now}`,
    '━━━━━━━━━━━━━━━━━━━━',
    '⚡ *সক্রিয় ব্যবহারকারী তালিকা (Active Only):*'
  ].join('\n');

  if (activeUsers.length === 0) {
    msg += '\n\n_বর্তমানে কোনো অ্যাক্টিভ ইউজার নেই। নতুন রিকোয়েস্ট এলে অনুমোদন করতে পারবেন।_';
  } else {
    msg += '\n\n';
    activeUsers.forEach((u, i) => {
      const duration = Number(u.duration);
      const durationLabel = duration === 0 ? 'Unlimited' : (duration > 0 ? `${duration}m` : '');
      const safeName = escapeMarkdown(u.name || 'Guest');
      msg += `${i + 1}. *${safeName}* • \`${u.mac}\` (${durationLabel})\n`;
    });
  }

  return msg.trim();
}

/**
 * Persistent Telegram Reply Keyboard (always visible at the bottom of the chat).
 */
export const TELEGRAM_MENU_KEYBOARD = {
  keyboard: [
    [{ text: '📊 ড্যাশবোর্ড' }, { text: '🟢 অ্যাক্টিভ ইউজার' }],
    [{ text: '👥 প্রিভিয়াস ইউজার' }, { text: '📋 ইউজার ডিটেইলস' }],
    [{ text: '🧹 ক্লিন ড্যাশবোর্ড' }]
  ],
  resize_keyboard: true,
  persistent: true
};

/**
 * Inline menu keyboard with callback triggers.
 */
export const TELEGRAM_INLINE_MENU = {
  inline_keyboard: [
    [
      { text: '📊 ড্যাশবোর্ড', callback_data: 'menu_dashboard' },
      { text: '🟢 অ্যাক্টিভ ইউজার', callback_data: 'menu_active' }
    ],
    [
      { text: '👥 প্রিভিয়াস ইউজার', callback_data: 'menu_previous' },
      { text: '📋 ইউজার ডিটেইলস', callback_data: 'menu_details' }
    ],
    [
      { text: '🧹 ক্লিন ড্যাশবোর্ড', callback_data: 'menu_clean' }
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
    const url = `https://api.telegram.org/bot${botToken}/setMyCommands`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commands: [
          { command: 'menu', description: 'প্রধান মেনু ও কন্ট্রোল বাটন' },
          { command: 'dashboard', description: 'লাইভ ড্যাশবোর্ড (শুধুমাত্র অ্যাক্টিভ ইউজার)' },
          { command: 'active', description: 'বর্তমানে অ্যাক্টিভ ইউজারের সংখ্যা ও তালিকা' },
          { command: 'previous', description: 'পূর্ববর্তী ইউজারদের তালিকা' },
          { command: 'details', description: 'সমস্ত ইউজারদের বিস্তারিত তথ্য' },
          { command: 'clean', description: 'ড্যাশবোর্ড ক্লিন করুন (টার্মিনেটেড ইউজার মুছুন)' }
        ]
      })
    });
  } catch (err) {
    console.warn('[registerBotCommands Warning]', err);
  }
}
