/**
 * /api/confirm-auth.js
 *
 * Endpoint for the OpenWrt router to confirm client authentication.
 * Once openNDS has successfully authorized the client (`ndsctl auth <MAC>`),
 * the router posts to this endpoint to mark the MAC status as 'AUTHENTICATED'.
 *
 * Supports payloads formatted as:
 * - URL-encoded form: `mac=b6:30:f7:f7:11:60` (curl -d "mac=...")
 * - JSON: `{ "mac": "b6:30:f7:f7:11:60" }`
 * - Plain text string
 */

import { Redis } from '@upstash/redis';
import { normalizeMac } from './request.js';
import { timingSafeCompare } from './poll.js';

// Regular expression to validate standard MAC addresses
const MAC_REGEX = /^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: `Method ${req.method} Not Allowed. Use POST.` });
  }

  // Optional router secret validation if x-router-secret is supplied
  const routerSecret = process.env.ROUTER_SECRET_KEY;
  const clientSecret = req.headers['x-router-secret'];
  if (clientSecret && routerSecret && !timingSafeCompare(clientSecret, routerSecret)) {
    return res.status(401).json({ error: 'Unauthorized: Invalid x-router-secret header.' });
  }

  let rawMac = null;

  // Extract MAC from various body formats
  if (typeof req.body === 'string') {
    const trimmed = req.body.trim();
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed);
        rawMac = parsed.mac;
      } catch {
        // Fall back to URLSearchParams
      }
    }
    if (!rawMac) {
      const params = new URLSearchParams(trimmed);
      rawMac = params.get('mac') || (MAC_REGEX.test(trimmed) ? trimmed : null);
    }
  } else if (req.body && typeof req.body === 'object') {
    rawMac = req.body.mac;
  }

  // Also check query string if not in body
  if (!rawMac && req.url) {
    try {
      const url = new URL(req.url, 'http://localhost');
      rawMac = url.searchParams.get('mac');
    } catch {
      // Ignore URL parsing errors
    }
  }

  if (!rawMac || !MAC_REGEX.test(String(rawMac).trim())) {
    return res.status(400).json({ error: 'Field "mac" is required and must be a valid MAC address.' });
  }

  const cleanMac = normalizeMac(rawMac);
  const nowIso = new Date().toISOString();

  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (redisUrl && redisToken) {
    try {
      const redis = new Redis({
        url: redisUrl,
        token: redisToken
      });

      // Update state in Redis to AUTHENTICATED
      await redis.hset(`request:${cleanMac}`, {
        status: 'AUTHENTICATED',
        authenticatedAt: nowIso,
        updatedAt: nowIso
      });

      // Remove from the pending queue
      await redis.lrem('pending_macs', 0, cleanMac);
    } catch (dbErr) {
      console.error('[Redis Confirm Auth Error]', dbErr);
      return res.status(500).json({ error: 'Failed to update database record.' });
    }
  }

  return res.status(200).json({
    success: true,
    mac: cleanMac,
    status: 'AUTHENTICATED'
  });
}
