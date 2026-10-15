/**
 * /api/router.js
 *
 * Cloud Bridge & Router Management API endpoint for ArcherGuard C6.
 * Modularized: routes requests to safety, status simulation, and command modules.
 * Kept strictly under 250 lines.
 */

import { Redis } from '@upstash/redis';
import { checkRouterAuth, isDangerousRouterCommand } from '../lib/router/safety.js';
import { getSimulatedStatus } from '../lib/router/status-sim.js';
import { getSimulatedTerminalOutput } from '../lib/router/terminal-sim.js';
import { buildRouterCommand } from '../lib/router/commands.js';

export { checkRouterAuth, isDangerousRouterCommand, getSimulatedStatus, getSimulatedTerminalOutput };

let lastLocalCheckFailed = 0;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Router-Secret, X-Admin-Password, X-Admin-Secret, Authorization');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  if (req.method === 'OPTIONS') {
    return res.status(200).json({ status: 'ok' });
  }

  const routerSecret = process.env.ARCHER_C6_SECRET || process.env.ROUTER_SECRET_KEY || process.env.ADMIN_PASSWORD;
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  let redis = null;
  if (redisUrl && redisToken) {
    try {
      redis = new Redis({ url: redisUrl, token: redisToken });
    } catch (e) {
      console.warn('[Router API] Redis initialization warning:', e.message);
    }
  }

  // 1. GET: Fetch router status metrics
  if (req.method === 'GET') {
    const hasAuth = req.headers?.['x-router-secret'] || req.headers?.['authorization'] || req.headers?.['x-admin-password'];
    if (routerSecret && hasAuth && !checkRouterAuth(req, routerSecret)) {
      return res.status(401).json({ error: 'Unauthorized: Invalid secret key.' });
    }

    if (redis) {
      try {
        const cachedStatus = await redis.get('router:latest_status');
        if (cachedStatus) {
          const parsed = typeof cachedStatus === 'string' ? JSON.parse(cachedStatus) : cachedStatus;
          return res.status(200).json(parsed);
        }
      } catch (e) {
        console.warn('[Router API] Could not read router:latest_status from Redis:', e.message);
      }
    }

    if (globalThis.__localRouterStatus && (Date.now() - (globalThis.__localRouterStatusTimestamp || 0)) < 6000) {
      return res.status(200).json(globalThis.__localRouterStatus);
    }

    if (process.env.NODE_ENV !== 'test' && (Date.now() - lastLocalCheckFailed > 10000)) {
      try {
        const liveRes = await fetch('http://192.168.1.1/cgi-bin/api?action=status', { signal: AbortSignal.timeout(10000) });
        if (liveRes.ok) {
          const liveData = await liveRes.json();
          liveData.source = liveData.source || 'local_router';
          globalThis.__localRouterStatus = liveData;
          globalThis.__localRouterStatusTimestamp = Date.now();
          return res.status(200).json(liveData);
        }
      } catch {
        lastLocalCheckFailed = Date.now();
      }
    }

    if (globalThis.__localRouterStatus) {
      return res.status(200).json(globalThis.__localRouterStatus);
    }

    return res.status(200).json(getSimulatedStatus());
  }

  // 2. POST: Telemetry reporting OR command enqueuing
  if (req.method === 'POST') {
    if (routerSecret && !checkRouterAuth(req, routerSecret)) {
      return res.status(401).json({ error: 'Unauthorized: Invalid or missing authentication secret.' });
    }

    const payload = req.body || {};

    if (payload.action === 'report_status') {
      if (!payload.status || typeof payload.status !== 'object') {
        return res.status(400).json({ error: 'Field "status" must be an object.' });
      }

      if (redis) {
        try {
          await redis.set('router:latest_status', JSON.stringify(payload.status), { ex: 300 });
        } catch (e) {
          console.warn('[Router API] Could not save status to Redis:', e.message);
        }
      }

      globalThis.__localRouterStatus = payload.status;
      return res.status(200).json({ status: 'ok', message: 'Metrics cached.' });
    }

    const commandResult = await buildRouterCommand(payload, req, redis);
    if (commandResult.error) {
      const errResp = { error: commandResult.error };
      if (commandResult.blocked) errResp.blocked = true;
      if (commandResult.command) errResp.command = commandResult.command;
      return res.status(commandResult.statusCode || 400).json(errResp);
    }

    const { routerCmd, simulatedOutput, cleanCmd } = commandResult;

    if (redis) {
      try {
        await redis.rpush('pending_commands', routerCmd);
      } catch (e) {
        console.warn('[Router API] Could not push to Redis queue:', e.message);
      }
    }

    if (Array.isArray(globalThis.__localDevQueue)) {
      globalThis.__localDevQueue.push(routerCmd);
    }

    const responsePayload = {
      success: true,
      command: cleanCmd,
      routerCmd,
      message: `Command "${cleanCmd}" enqueued for Archer C6 execution.`
    };
    if (simulatedOutput !== null) {
      responsePayload.output = simulatedOutput;
    }

    return res.status(200).json(responsePayload);
  }

  res.setHeader('Allow', 'GET, POST, OPTIONS');
  return res.status(405).json({ error: `Method ${req.method} Not Allowed. Use GET or POST.` });
}
