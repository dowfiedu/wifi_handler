/**
 * /api/admin.js
 *
 * Secure serverless administration endpoint for the Wi-Fi captive portal.
 * Modularized: routes requests to auth, request fetching, and notification modules.
 * Kept strictly under 250 lines.
 */

import { Redis } from '@upstash/redis';
import { normalizeMac } from './request.js';
import { cleanTerminatedRecords } from '../lib/bot-menu.js';
import { MAC_REGEX, checkAdminAuth } from '../lib/admin/auth.js';
import { fetchAdminRequests } from '../lib/admin/requests.js';
import { sendAdminTelegramNotice } from '../lib/admin/notifications.js';

export { MAC_REGEX, checkAdminAuth };

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: `Method ${req.method} Not Allowed. Use GET or POST.` });
  }

  if (req.method === 'POST' && typeof req.body === 'string') {
    try {
      req.body = JSON.parse(req.body);
    } catch {
      return res.status(400).json({ error: 'Malformed JSON payload in request body.' });
    }
  }

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

  if (!checkAdminAuth(req, expectedPassword)) {
    return res.status(401).json({ error: 'Unauthorized: Invalid or missing admin credentials.' });
  }

  // 1. GET: Retrieve requests list and router queue count
  if (req.method === 'GET') {
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
      const data = await fetchAdminRequests(redis);
      return res.status(200).json({ ok: true, ...data });
    } catch (err) {
      console.error('[Admin GET Error]', err);
      return res.status(500).json({ error: 'Failed to retrieve request data from Redis database.' });
    }
  }

  // 2. POST: Execute action (auth / deauth / clean / login)
  const { action, mac, duration = 60, name, adminName = 'Web Admin' } = req.body || {};

  if (action === 'login') {
    return res.status(200).json({ ok: true, message: 'Admin login verified successfully.' });
  }

  if (action === 'clean') {
    if (!redisUrl || !redisToken) {
      return res.status(500).json({ error: 'Server configuration error: Redis credentials missing.' });
    }
    try {
      const redis = new Redis({ url: redisUrl, token: redisToken });
      const cleanResult = await cleanTerminatedRecords(redis);
      return res.status(200).json({
        ok: true,
        success: true,
        message: `Successfully cleaned ${cleanResult.removedCount} terminated records from database.`,
        removedCount: cleanResult.removedCount,
        remainingCount: cleanResult.remainingCount
      });
    } catch (cleanErr) {
      console.error('[Admin Clean Error]', cleanErr);
      return res.status(500).json({ error: 'Failed to clean database records.' });
    }
  }

  if (action !== 'auth' && action !== 'deauth') {
    return res.status(400).json({
      error: 'Invalid action. Supported actions are "auth", "deauth", and "clean" (or "login").'
    });
  }

  if (!mac || typeof mac !== 'string' || !MAC_REGEX.test(mac.trim())) {
    return res.status(400).json({
      error: 'Field "mac" is required and must be a valid MAC address (e.g. AA:BB:CC:DD:EE:FF).'
    });
  }
  const cleanMac = normalizeMac(mac);

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
    const command = action === 'auth' ? `ndsctl auth ${cleanMac} ${parsedDuration}` : `ndsctl deauth ${cleanMac}`;

    await redis.rpush('pending_commands', command);

    const newStatus = action === 'auth' ? 'authorized' : 'rejected';
    const cleanName = name ? String(name).trim().slice(0, 64) : null;
    const hashUpdate = {
      status: newStatus,
      duration: parsedDuration,
      reviewedBy: adminName,
      reviewedAt: nowIso
    };
    if (cleanName) hashUpdate.name = cleanName;

    await redis.hset(`request:${cleanMac}`, hashUpdate);
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

    sendAdminTelegramNotice(botToken, chatId, action, cleanMac, cleanName, parsedDuration, adminName);

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
    return res.status(500).json({ error: 'Failed to process admin action in Redis database.' });
  }
}
