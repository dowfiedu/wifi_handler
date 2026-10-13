/**
 * /api/webhook.js
 *
 * Telegram Webhook receiver.
 * Listens for `callback_query` updates triggered when an admin clicks an inline button.
 * Parses the action (auth/deauth), MAC address, and duration, builds the corresponding
 * openNDS command (`ndsctl auth ...` or `ndsctl deauth ...`), queues it in Upstash Redis,
 * and acknowledges the callback query.
 */

import { Redis } from '@upstash/redis';
import { escapeMarkdown } from './request.js';

// Regular expression to validate standard MAC addresses
const MAC_REGEX = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i;

/**
 * Safely parses the callback_data string from Telegram.
 *
 * Formats supported:
 *  - "deauth_<mac>"          -> e.g. "deauth_aa:bb:cc:dd:ee:ff" (Terminate / Disconnect)
 *  - "deauth:<mac>"          -> e.g. "deauth:aa:bb:cc:dd:ee:ff"
 *  - "auth:<mac>:<duration>" -> e.g. "auth:aa:bb:cc:dd:ee:ff:30", "auth:aa:bb:cc:dd:ee:ff:60", "auth:aa:bb:cc:dd:ee:ff:0"
 *  - "auth_<mac>_<duration>" -> e.g. "auth_aa:bb:cc:dd:ee:ff_60", "auth_aa:bb:cc:dd:ee:ff_0"
 *
 * @param {string} data - Raw callback_data string
 * @returns {{ action: string, mac: string, duration: number|null } | null}
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

  return null;
}

/**
 * Helper to answer Telegram callback query to dismiss the loading spinner on Telegram UI.
 */
async function answerCallbackQuery(botToken, callbackQueryId, text, showAlert = false) {
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
 * Helper to update original Telegram message to reflect the chosen action.
 * Attaches a "❌ Terminate" button when authorized so admins can instantly revoke access.
 */
async function updateTelegramMessage(botToken, message, statusText, inlineKeyboard = []) {
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

  // Check if update contains a callback_query
  const callbackQuery = update?.callback_query;
  if (!callbackQuery) {
    // Return 200 OK to acknowledge Telegram updates we don't handle (e.g. standard chat messages)
    return res.status(200).json({ ok: true, message: 'No callback query to process.' });
  }

  const { id: callbackQueryId, data, message, from } = callbackQuery;
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

  const { action, mac, duration } = parsed;

  // Build the openNDS command to be queued for the router
  // openNDS command syntax:
  // - ndsctl auth <MAC> <minutes>   (minutes=0 denotes default/unlimited)
  // - ndsctl deauth <MAC>
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
    // Rule 3: Attach "❌ Terminate" button with callback_data "deauth_<MAC>"
    inlineKeyboard = [
      [
        { text: '❌ Terminate', callback_data: `deauth_${mac}` }
      ]
    ];
  } else if (action === 'deauth') {
    command = `ndsctl deauth ${mac}`;
    ackMessage = `❌ Terminated ${mac}`;
    statusNotice = `❌ *Status:* Terminated / Revoked by ${safeAdminName}`;
    inlineKeyboard = []; // Rule 3: Remove buttons once terminated
  }

  try {
    // Initialize Upstash Redis client
    const redis = new Redis({
      url: redisUrl,
      token: redisToken
    });

    // Push the command to the tail of the 'pending_commands' queue (FIFO)
    await redis.rpush('pending_commands', command);

    // Update the request status in the Redis database
    await redis.hset(`request:${mac}`, {
      status: action === 'auth' ? 'authorized' : 'terminated',
      duration: duration ?? 0,
      reviewedBy: adminName,
      reviewedAt: new Date().toISOString()
    });

    // Acknowledge the callback query to clear the Telegram client loading spinner
    await answerCallbackQuery(botToken, callbackQueryId, ackMessage, false);

    // Update the message in Telegram to reflect status and update inline keyboard
    await updateTelegramMessage(botToken, message, statusNotice, inlineKeyboard);

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
