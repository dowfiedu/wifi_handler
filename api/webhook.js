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

// Regular expression to validate standard MAC addresses
const MAC_REGEX = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i;

/**
 * Safely parses the callback_data string from Telegram.
 *
 * Formats:
 *  - "auth:<mac>:<duration>" -> e.g. "auth:aa:bb:cc:dd:ee:ff:60"
 *  - "deauth:<mac>"          -> e.g. "deauth:aa:bb:cc:dd:ee:ff"
 *
 * Note: MAC addresses contain colons, so naive split(':') will split the MAC into 6 parts.
 * We safely parse the prefix and suffix around the 6-byte MAC.
 *
 * @param {string} data - Raw callback_data string
 * @returns {{ action: string, mac: string, duration: number|null } | null}
 */
export function parseCallbackData(data) {
  if (!data || typeof data !== 'string') return null;

  const firstColon = data.indexOf(':');
  if (firstColon === -1) return null;

  const action = data.slice(0, firstColon).toLowerCase();
  const rest = data.slice(firstColon + 1);

  if (action === 'auth') {
    const lastColon = rest.lastIndexOf(':');
    if (lastColon === -1) return null;

    const mac = rest.slice(0, lastColon).toLowerCase().replace(/-/g, ':');
    const durationStr = rest.slice(lastColon + 1);
    const duration = parseInt(durationStr, 10);

    if (isNaN(duration) || duration < 0 || !MAC_REGEX.test(mac)) {
      return null;
    }

    return { action: 'auth', mac, duration };
  }

  if (action === 'deauth') {
    const mac = rest.toLowerCase().replace(/-/g, ':');
    if (!MAC_REGEX.test(mac)) {
      return null;
    }

    return { action: 'deauth', mac, duration: null };
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
 */
async function updateTelegramMessage(botToken, message, statusText) {
  if (!message || !message.chat || !message.message_id) return;

  try {
    const originalText = message.text || '';
    const updatedText = `${originalText}\n\n${statusText}`;
    const url = `https://api.telegram.org/bot${botToken}/editMessageText`;

    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: message.chat.id,
        message_id: message.message_id,
        text: updatedText,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [] } // Remove buttons once action is taken
      })
    });
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
  const adminName = from?.first_name || 'Admin';

  if (action === 'auth') {
    command = `ndsctl auth ${mac} ${duration}`;
    const durationLabel = duration === 0 ? 'Unlimited' : `${duration}m`;
    ackMessage = `✅ Authorized ${mac} (${durationLabel})`;
    statusNotice = `✅ *Status:* Authorized (${durationLabel}) by ${adminName}`;
  } else if (action === 'deauth') {
    command = `ndsctl deauth ${mac}`;
    ackMessage = `❌ Deauthorized ${mac}`;
    statusNotice = `❌ *Status:* Disconnected / Rejected by ${adminName}`;
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
      status: action === 'auth' ? 'authorized' : 'rejected',
      duration: duration ?? 0,
      reviewedBy: adminName,
      reviewedAt: new Date().toISOString()
    });

    // Acknowledge the callback query to clear the Telegram client loading spinner
    await answerCallbackQuery(botToken, callbackQueryId, ackMessage, false);

    // Update the message in Telegram to show final status and remove action buttons
    await updateTelegramMessage(botToken, message, statusNotice);

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
