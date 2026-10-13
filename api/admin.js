/**
 * /api/admin.js
 *
 * Secure serverless administration endpoint for the Wi-Fi captive portal.
 * - Authenticates admin requests via Bearer token, x-admin-password header, or query parameter.
 * - GET: Retrieves recent client access requests, approval states, and pending router command queue status.
 * - POST: Allows direct authorization (auth) or deauthorization (deauth) of client MAC addresses,
 *   pushing the corresponding openNDS command to Upstash Redis ('pending_commands')
 *   and notifying the Telegram bot if configured.
 */

import { Redis } from '@upstash/redis';
import { normalizeMac, escapeMarkdown } from './request.js';
import { timingSafeCompare } from './poll.js';

// Regular expression to validate standard MAC addresses (colon or hyphen separated)
export const MAC_REGEX = /^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/;

/**
 * Extracts and verifies the admin credentials from request headers, query string, or body.
 *
 * @param {object} req - HTTP request object
 * @param {string} expectedSecret - Configured admin secret or password
 * @returns {boolean} - True if authenticated, false otherwise
 */
export function checkAdminAuth(req, expectedSecret) {
  if (!req || typeof req !== 'object') return false;
  if (!expectedSecret || typeof expectedSecret !== 'string') return false;

  const authHeader = req.headers?.['authorization'] || '';
  const customHeader = req.headers?.['x-admin-password'] || req.headers?.['x-admin-secret'] || '';

  let candidate = '';

  if (typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')) {
    candidate = authHeader.slice(7).trim();
  } else if (typeof customHeader === 'string' && customHeader.trim()) {
    candidate = customHeader.trim();
  } else if (req.url) {
    try {
      const url = new URL(req.url, 'http://localhost');
      const querySecret = url.searchParams.get('password') || url.searchParams.get('secret');
      if (querySecret) candidate = querySecret.trim();
    } catch {
      // Ignore URL parsing errors
    }
  }

  // Also check JSON body if available
  if (!candidate && req.body && typeof req.body === 'object' && req.body.password) {
    candidate = String(req.body.password).trim();
  }

  return candidate ? timingSafeCompare(candidate, expectedSecret) : false;
}

/**
 * Vercel Serverless Function Handler
 */
export default async function handler(req, res) {
  // Prevent any caching on administration API responses
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  // Allow GET and POST only
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: `Method ${req.method} Not Allowed. Use GET or POST.` });
  }

  // Parse request body for POST requests if provided as a string
  if (req.method === 'POST' && typeof req.body === 'string') {
    try {
      req.body = JSON.parse(req.body);
    } catch {
      return res.status(400).json({ error: 'Malformed JSON payload in request body.' });
    }
  }

  // Configured password: check ADMIN_PASSWORD first, fallback to ROUTER_SECRET_KEY
  const expectedPassword = process.env.ADMIN_PASSWORD || process.env.ROUTER_SECRET_KEY;
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!expectedPassword) {
    console.error('[Config Error] Missing ADMIN_PASSWORD or ROUTER_SECRET_KEY in environment variables.');
    return res.status(500).json({
      error: 'Server configuration error: Admin credentials are not configured (set ADMIN_PASSWORD or ROUTER_SECRET_KEY).'
    });
  }

  // Verify Admin Authentication
  const isAuthenticated = checkAdminAuth(req, expectedPassword);
  if (!isAuthenticated) {
    return res.status(401).json({
      error: 'Unauthorized: Invalid or missing admin credentials.'
    });
  }

  // ---------------------------------------------------------------------------
  // GET: Retrieve requests list and router queue count
  // ---------------------------------------------------------------------------
  if (req.method === 'GET') {
    // If just checking authentication
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.searchParams.get('action') === 'check') {
        return res.status(200).json({ ok: true, message: 'Authenticated successfully.' });
      }
    } catch {}

    if (!redisUrl || !redisToken) {
      return res.status(500).json({ error: 'Server configuration error: Redis credentials missing.' });
    }

    try {
      const redis = new Redis({ url: redisUrl, token: redisToken });

      // Fetch pending router queue count
      const pendingQueueCount = await redis.llen('pending_commands');

      // Fetch recent request history (last 100 entries)
      const rawHistory = await redis.lrange('request_history', 0, 99);

      const parsedItems = [];
      const seenMacs = new Set();

      for (const item of rawHistory) {
        try {
          const entry = typeof item === 'string' ? JSON.parse(item) : item;
          if (entry && entry.mac && !seenMacs.has(entry.mac)) {
            seenMacs.add(entry.mac);
            parsedItems.push(entry);
          }
        } catch {
          // Skip invalid entries
        }
      }

      // Fetch latest hash status for each unique MAC
      const requests = await Promise.all(
        parsedItems.map(async (entry) => {
          try {
            const hash = await redis.hgetall(`request:${entry.mac}`);
            return {
              name: entry.name || hash?.name || 'Guest User',
              mac: entry.mac,
              ip: entry.ip || hash?.ip || '',
              status: hash?.status || entry.status || 'pending',
              duration: hash?.duration !== undefined ? Number(hash.duration) : (entry.duration ? Number(entry.duration) : null),
              requestedAt: entry.requestedAt || hash?.requestedAt || null,
              reviewedAt: hash?.reviewedAt || entry.reviewedAt || null,
              reviewedBy: hash?.reviewedBy || entry.reviewedBy || null
            };
          } catch {
            return entry;
          }
        })
      );

      return res.status(200).json({
        ok: true,
        pendingQueueCount: Number(pendingQueueCount) || 0,
        requests
      });
    } catch (err) {
      console.error('[Admin GET Error]', err);
      return res.status(500).json({ error: 'Failed to retrieve request data from Redis database.' });
    }
  }

  // ---------------------------------------------------------------------------
  // POST: Execute action (auth / deauth / login test)
  // ---------------------------------------------------------------------------
  const { action, mac, duration = 60, name, adminName = 'Web Admin' } = req.body || {};

  // Action: Simple login test
  if (action === 'login') {
    return res.status(200).json({ ok: true, message: 'Admin login verified successfully.' });
  }

  // Action must be either 'auth' or 'deauth'
  if (action !== 'auth' && action !== 'deauth') {
    return res.status(400).json({
      error: 'Invalid action. Supported actions are "auth" and "deauth" (or "login").'
    });
  }

  // Validate MAC address
  if (!mac || typeof mac !== 'string' || !MAC_REGEX.test(mac.trim())) {
    return res.status(400).json({
      error: 'Field "mac" is required and must be a valid MAC address (e.g. AA:BB:CC:DD:EE:FF).'
    });
  }
  const cleanMac = normalizeMac(mac);

  // Validate duration for auth action (0 = unlimited, > 0 = minutes)
  let parsedDuration = 0;
  if (action === 'auth') {
    parsedDuration = parseInt(duration, 10);
    if (isNaN(parsedDuration) || parsedDuration < 0) {
      return res.status(400).json({
        error: 'Field "duration" must be a positive integer or 0 for unlimited access.'
      });
    }
  }

  if (!redisUrl || !redisToken) {
    return res.status(500).json({ error: 'Server configuration error: Redis credentials missing.' });
  }

  try {
    const redis = new Redis({ url: redisUrl, token: redisToken });
    const nowIso = new Date().toISOString();

    // Construct openNDS command
    // openNDS command syntax:
    // - ndsctl auth <MAC> <minutes>   (minutes=0 denotes default/unlimited)
    // - ndsctl deauth <MAC>
    const command = action === 'auth'
      ? `ndsctl auth ${cleanMac} ${parsedDuration}`
      : `ndsctl deauth ${cleanMac}`;

    // 1. Queue command to tail of Redis 'pending_commands' list
    await redis.rpush('pending_commands', command);

    // 2. Update request state hash in Redis
    const newStatus = action === 'auth' ? 'authorized' : 'rejected';
    const cleanName = name ? String(name).trim().slice(0, 64) : null;

    const hashUpdate = {
      status: newStatus,
      duration: parsedDuration,
      reviewedBy: adminName,
      reviewedAt: nowIso
    };
    if (cleanName) {
      hashUpdate.name = cleanName;
    }

    await redis.hset(`request:${cleanMac}`, hashUpdate);

    // 3. Log to chronological request history
    await redis.lpush('request_history', JSON.stringify({
      name: cleanName || 'Guest User',
      mac: cleanMac,
      status: newStatus,
      duration: parsedDuration,
      reviewedBy: adminName,
      requestedAt: nowIso,
      reviewedAt: nowIso
    }));
    await redis.ltrim('request_history', 0, 499);

    // 4. Optional Telegram notification to inform admin channel of Web Panel action
    if (botToken && chatId) {
      try {
        const durationLabel = parsedDuration === 0 ? 'Unlimited' : `${parsedDuration}m`;
        const actionNotice = action === 'auth'
          ? [
              '🌐 *Web Admin: Wi-Fi Access Authorized*',
              '━━━━━━━━━━━━━━━━━━━━',
              cleanName ? `👤 *User:* ${escapeMarkdown(cleanName)}` : null,
              `🏷 *MAC:* \`${cleanMac}\``,
              `⏱ *Duration:* ${durationLabel}`,
              `🛡 *Authorized by:* ${escapeMarkdown(adminName)}`,
              '━━━━━━━━━━━━━━━━━━━━'
            ].filter(Boolean).join('\n')
          : [
              '🌐 *Web Admin: Wi-Fi Disconnected / Rejected*',
              '━━━━━━━━━━━━━━━━━━━━',
              `🏷 *MAC:* \`${cleanMac}\``,
              `🛡 *Action by:* ${escapeMarkdown(adminName)}`,
              '━━━━━━━━━━━━━━━━━━━━'
            ].join('\n');

        fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: actionNotice,
            parse_mode: 'Markdown'
          })
        }).catch((tgErr) => console.error('[Admin Telegram Sync Notice Failed]', tgErr));
      } catch (tgEx) {
        console.warn('[Telegram Dispatch Warning]', tgEx);
      }
    }

    return res.status(200).json({
      ok: true,
      success: true,
      action,
      mac: cleanMac,
      duration: action === 'auth' ? parsedDuration : null,
      commandQueued: command,
      message: action === 'auth'
        ? `Successfully authorized ${cleanMac} (${parsedDuration === 0 ? 'Unlimited' : `${parsedDuration} min`}).`
        : `Successfully queued deauthorization for ${cleanMac}.`
    });
  } catch (error) {
    console.error('[Admin Action Handler Exception]', error);
    return res.status(500).json({
      error: 'Failed to process admin action in Redis database.'
    });
  }
}
