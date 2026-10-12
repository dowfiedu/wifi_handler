/**
 * /api/poll.js
 *
 * Endpoint for the OpenWrt router to poll pending commands.
 * Authenticates requests using the `x-router-secret` header against `ROUTER_SECRET_KEY`.
 * Pops the next pending command from Upstash Redis ('pending_commands' queue) via LPOP.
 *
 * Returns: { command: "ndsctl auth <MAC> <minutes>" | "ndsctl deauth <MAC>" | null }
 */

import { Redis } from '@upstash/redis';
import crypto from 'node:crypto';

/**
 * Constant-time string comparison to prevent timing attacks on the router secret.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function timingSafeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Vercel Serverless Function Handler
 */
export default async function handler(req, res) {
  // Disallow caching on polling responses to guarantee real-time queue states
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  // Allow GET or POST for polling
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: `Method ${req.method} Not Allowed. Use GET or POST.` });
  }

  const routerSecret = process.env.ROUTER_SECRET_KEY;
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  // Verify server environment configuration
  if (!routerSecret || !redisUrl || !redisToken) {
    console.error('[Config Error] Missing ROUTER_SECRET_KEY or UPSTASH credentials in environment.');
    return res.status(500).json({ error: 'Server configuration error.' });
  }

  // Validate the router secret from header
  const clientSecret = req.headers['x-router-secret'];

  if (!clientSecret || !timingSafeCompare(clientSecret, routerSecret)) {
    return res.status(401).json({
      error: 'Unauthorized: Invalid or missing x-router-secret header.'
    });
  }

  try {
    // Initialize Upstash Redis client
    const redis = new Redis({
      url: redisUrl,
      token: redisToken
    });

    // Pop the next command from the head of the queue (FIFO queue)
    const command = await redis.lpop('pending_commands');

    return res.status(200).json({
      command: command || null
    });
  } catch (error) {
    console.error('[Poll Queue Exception]', error);
    return res.status(500).json({
      error: 'Failed to retrieve command from Redis queue.'
    });
  }
}
