/**
 * dev-server.js
 *
 * Lightweight local development server using Node.js built-in modules.
 * - Serves static files from `public/` (e.g. index.html)
 * - Emulates Vercel Serverless Functions (/api/request, /api/poll, /api/webhook)
 * - Automatically loads .env or .env.local if present
 * - Provides realistic simulation fallback if Telegram/Redis tokens are not yet configured,
 *   enabling full local UI testing without external cloud dependencies.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Import our serverless handlers
import requestHandler from './api/request.js';
import webhookHandler, { parseCallbackData } from './api/webhook.js';
import pollHandler from './api/poll.js';
import adminHandler from './api/admin.js';
import loginHandler from './api/login.js';
import pendingAuthHandler from './api/pending-auth.js';
import confirmAuthHandler from './api/confirm-auth.js';
import statusHandler from './api/status.js';
import routerHandler from './api/router.js';
import deauthHandler from './api/deauth.js';
import { parseFasToken } from './lib/opennds.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Try loading local environment variables if available
const envFiles = ['.env.local', '.env'];
for (const envFile of envFiles) {
  const envPath = path.join(__dirname, envFile);
  if (fs.existsSync(envPath) && typeof process.loadEnvFile === 'function') {
    try {
      process.loadEnvFile(envPath);
      console.log(`[Dev Server] Loaded environment from ${envFile}`);
      break;
    } catch (e) {
      console.warn(`[Dev Server] Notice: Could not parse ${envFile}:`, e.message);
    }
  }
}

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

/**
 * Creates standard Express/Vercel-like response helpers (res.status, res.json, res.setHeader)
 */
function enhanceResponse(res) {
  res.status = function (statusCode) {
    res.statusCode = statusCode;
    return res;
  };

  res.json = function (data) {
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'application/json');
    }
    res.end(JSON.stringify(data));
    return res;
  };

  return res;
}

/**
 * Parses JSON request bodies
 */
async function parseBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      if (!raw) return resolve(null);
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(raw);
      }
    });
  });
}

// In-memory queue and requests list used for local dev simulation if Upstash Redis credentials are not configured
const localDevQueue = [];
globalThis.__localDevQueue = localDevQueue;
const localDevPendingMacs = ['4a:8b:9c:1d:2e:3f', '6c:7d:8e:9f:0a:1b'];
const localDevRequests = [
  {
    name: 'রহিম আহমেদ (Rahim)',
    mac: '4a:8b:9c:1d:2e:3f',
    ip: '192.168.1.105',
    status: 'pending',
    requestedAt: new Date(Date.now() - 1000 * 60 * 3).toISOString()
  },
  {
    name: 'সাদিয়া ইসলাম (Sadia)',
    mac: '6c:7d:8e:9f:0a:1b',
    ip: '192.168.1.112',
    status: 'pending',
    requestedAt: new Date(Date.now() - 1000 * 60 * 12).toISOString()
  }
];

const server = http.createServer(async (req, res) => {
  enhanceResponse(res);

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  // Enable CORS for local testing
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-router-secret, x-admin-password, x-admin-secret');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // --- API Routing ---
  if (pathname === '/api/login') {
    req.body = await parseBody(req);
    if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
      return loginHandler(req, res);
    }

    const { fas, name, mac, ip } = req.body || {};
    let clientMac = mac;
    let clientIp = ip;
    if (fas && typeof fas === 'string') {
      const parsed = parseFasToken(fas);
      if (parsed.clientMac) clientMac = parsed.clientMac;
      if (parsed.clientIp) clientIp = parsed.clientIp;
    }

    if (!clientMac) {
      return res.status(400).json({ error: 'Valid client MAC not found' });
    }

    const cleanMac = clientMac.trim().toLowerCase();
    const cleanName = name?.trim() || 'Guest User';

    const existingIdx = localDevPendingMacs.indexOf(cleanMac);
    if (existingIdx !== -1) localDevPendingMacs.splice(existingIdx, 1);
    localDevPendingMacs.push(cleanMac);

    const existingReq = localDevRequests.find(r => r.mac === cleanMac);
    if (existingReq) {
      existingReq.status = 'PENDING';
      existingReq.name = cleanName;
      existingReq.ip = clientIp || existingReq.ip;
      existingReq.requestedAt = new Date().toISOString();
    } else {
      localDevRequests.unshift({
        name: cleanName,
        mac: cleanMac,
        ip: clientIp || '',
        status: 'PENDING',
        requestedAt: new Date().toISOString()
      });
    }

    console.log(`\n--- 🔑 [LOCAL DEV: FAS LOGIN] ---`);
    console.log(`MAC:         ${cleanMac}`);
    console.log(`IP:          ${clientIp || '(none)'}`);
    console.log(`Status:      PENDING`);
    console.log(`Queue Size:  ${localDevPendingMacs.length}`);
    console.log(`---------------------------------\n`);

    return res.status(200).json({ success: true, mac: cleanMac, ip: clientIp, simulated: true });
  }

  if (pathname === '/api/pending-auth') {
    if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
      return pendingAuthHandler(req, res);
    }

    const pendingMac = localDevPendingMacs[0] || null;
    const accept = req.headers['accept'] || '';
    if (accept.includes('application/json') || parsedUrl.searchParams.get('format') === 'json') {
      return res.status(200).json({ mac: pendingMac, simulated: true });
    }

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.status(200).end(pendingMac || '');
  }

  if (pathname === '/api/confirm-auth') {
    req.body = await parseBody(req);
    if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
      return confirmAuthHandler(req, res);
    }

    let targetMac = null;
    if (typeof req.body === 'string') {
      const params = new URLSearchParams(req.body);
      targetMac = params.get('mac') || req.body.trim();
    } else if (req.body && typeof req.body === 'object') {
      targetMac = req.body.mac;
    }
    if (!targetMac) {
      targetMac = parsedUrl.searchParams.get('mac');
    }

    if (!targetMac) {
      return res.status(400).json({ error: 'Field "mac" is required and must be a valid MAC address.' });
    }

    const cleanMac = targetMac.trim().toLowerCase();
    const idx = localDevPendingMacs.indexOf(cleanMac);
    if (idx !== -1) {
      localDevPendingMacs.splice(idx, 1);
    }

    const reqRecord = localDevRequests.find(r => r.mac === cleanMac);
    if (reqRecord) {
      reqRecord.status = 'AUTHENTICATED';
      reqRecord.authenticatedAt = new Date().toISOString();
    }

    console.log(`\n--- ✅ [LOCAL DEV: AUTH CONFIRMED] ---`);
    console.log(`MAC:         ${cleanMac}`);
    console.log(`Status:      AUTHENTICATED`);
    console.log(`Remaining:   ${localDevPendingMacs.length}`);
    console.log(`--------------------------------------\n`);

    return res.status(200).json({ success: true, mac: cleanMac, status: 'AUTHENTICATED', simulated: true });
  }

  if (pathname === '/api/router') {
    req.body = await parseBody(req);
    return routerHandler(req, res);
  }

  if (pathname === '/api/deauth') {
    req.body = await parseBody(req);
    return deauthHandler(req, res);
  }

  if (pathname === '/api/status') {
    if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
      return statusHandler(req, res);
    }

    const targetMac = parsedUrl.searchParams.get('mac');
    if (!targetMac) {
      return res.status(400).json({ error: 'Query parameter "mac" is required.' });
    }

    const cleanMac = targetMac.trim().toLowerCase();
    const reqRecord = localDevRequests.find(r => r.mac.toLowerCase() === cleanMac);

    if (!reqRecord) {
      return res.status(200).json({ mac: cleanMac, status: 'pending', simulated: true });
    }

    const st = (reqRecord.status || 'pending').toLowerCase();
    return res.status(200).json({
      mac: cleanMac,
      name: reqRecord.name,
      status: st,
      duration: reqRecord.duration !== undefined ? reqRecord.duration : 0,
      simulated: true
    });
  }

  if (pathname === '/api/request') {
    req.body = await parseBody(req);

    // If Telegram credentials are configured, execute the real production handler
    if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
      return requestHandler(req, res);
    }

    // Otherwise, simulate Telegram dispatch locally so the frontend UI can be fully previewed
    const { name, mac, ip } = req.body || {};
    console.log('\n--- 📱 [LOCAL DEV: DATABASE & TELEGRAM SIMULATION] ---');
    console.log(`👤 Name:      ${name || '(none)'}`);
    console.log(`🏷  MAC:       ${mac || '(none)'}`);
    console.log(`🌐 IP:        ${ip || '(not provided)'}`);
    console.log(`💾 DB Store:  Saved to Upstash Redis -> key: "request:${mac}" [status: pending]`);
    console.log('🔘 Buttons simulated: [30 Mins] [1 Hour] [Unlimited] [Reject / Terminate]');
    console.log('------------------------------------------------------\n');

    if (!name || !mac) {
      return res.status(400).json({ error: 'Field "name" and "mac" are required.' });
    }

    // Store in dev simulation requests list
    localDevRequests.unshift({
      name: name.trim(),
      mac: mac.trim().toLowerCase(),
      ip: ip ? ip.trim() : '',
      status: 'pending',
      requestedAt: new Date().toISOString()
    });

    return res.status(200).json({
      success: true,
      simulated: true,
      message: 'Local Simulation: Request stored in database & sent to Telegram (Dev Mode).'
    });
  }

  if (pathname === '/api/webhook' || pathname === '/api/telegram') {
    req.body = await parseBody(req);
    if (process.env.TELEGRAM_BOT_TOKEN && process.env.UPSTASH_REDIS_REST_URL) {
      return webhookHandler(req, res);
    }

    // In local dev simulation mode:
    const message = req.body?.message;
    if (message && message.text) {
      console.log(`\n--- 📱 [LOCAL DEV: SIMULATED TELEGRAM MESSAGE] ---`);
      console.log(`Text: "${message.text}"`);
      console.log(`-------------------------------------------------\n`);
      return res.status(200).json({ ok: true, simulated: true, text: message.text });
    }

    const callbackQuery = req.body?.callback_query;
    if (callbackQuery) {
      const parsed = parseCallbackData(callbackQuery.data);
      if (parsed) {
        if (parsed.action === 'menu') {
          console.log(`\n--- 📱 [LOCAL DEV: SIMULATED TELEGRAM MENU CALLBACK] ---`);
          console.log(`Command: ${parsed.command}`);
          console.log(`------------------------------------------------------\n`);
          return res.status(200).json({ ok: true, simulated: true, menuCommand: parsed.command });
        }

        const { action, mac, duration } = parsed;
        const cmd = action === 'auth' ? `ndsctl auth ${mac} ${duration}` : `ndsctl deauth ${mac}`;
        localDevQueue.push(cmd);

        // Update in-memory dev requests status
        const cleanMac = mac.toLowerCase();
        const found = localDevRequests.find(r => r.mac.toLowerCase() === cleanMac);
        if (found) {
          found.status = action === 'auth' ? 'authorized' : 'rejected';
          found.duration = duration;
          found.reviewedAt = new Date().toISOString();
          found.reviewedBy = 'Telegram Bot Admin';
        }

        console.log(`\n--- 📱 [LOCAL DEV: SIMULATED TELEGRAM CALLBACK] ---`);
        console.log(`Action:         ${action.toUpperCase()}`);
        console.log(`MAC:            ${mac}`);
        console.log(`Duration:       ${duration !== null ? (duration === 0 ? 'Unlimited' : `${duration}m`) : 'N/A'}`);
        console.log(`Router Command: ${cmd}`);
        console.log(`Queue Size:     ${localDevQueue.length}`);
        console.log(`-------------------------------------------------\n`);
        return res.status(200).json({ ok: true, simulated: true, commandQueued: cmd });
      }
    }

    return res.status(200).json({ ok: true, simulated: true });
  }

  if (pathname === '/api/poll') {
    if (process.env.ROUTER_SECRET_KEY && process.env.UPSTASH_REDIS_REST_URL) {
      return pollHandler(req, res);
    }

    // Simulation for router polling
    const secret = req.headers['x-router-secret'];
    if (!secret) {
      return res.status(401).json({ error: 'Missing x-router-secret header.' });
    }

    const cmd = localDevQueue.shift() || null;
    return res.status(200).json({ command: cmd, simulated: true });
  }

  if (pathname === '/api/admin') {
    req.body = await parseBody(req);

    // If production Redis is configured along with admin password or router secret, run real handler
    if (process.env.UPSTASH_REDIS_REST_URL && (process.env.ADMIN_PASSWORD || process.env.ROUTER_SECRET_KEY)) {
      return adminHandler(req, res);
    }

    // Local dev simulation for Admin Dashboard
    const devPassword = process.env.ADMIN_PASSWORD || process.env.ROUTER_SECRET_KEY || 'admin123';
    const authHeader = req.headers['authorization'] || '';
    const provided = authHeader.replace(/^Bearer\s+/i, '').trim() || req.headers['x-admin-password'];

    // In dev mode: allow 'admin123' or configured password or anything if not strictly set
    if (provided && provided !== devPassword && devPassword !== 'admin123') {
      return res.status(401).json({ error: 'Unauthorized: Invalid admin credentials (Dev Mode).' });
    }

    if (req.method === 'GET') {
      return res.status(200).json({
        ok: true,
        simulated: true,
        pendingQueueCount: localDevQueue.length,
        requests: localDevRequests
      });
    }

    if (req.method === 'POST') {
      const { action, mac, duration = 60, name } = req.body || {};

      if (action === 'login') {
        return res.status(200).json({ ok: true, simulated: true, message: 'Logged in successfully (Dev Mode).' });
      }

      if (action === 'clean') {
        const initialCount = localDevRequests.length;
        const filtered = localDevRequests.filter(r => r.status !== 'rejected' && r.status !== 'terminated');
        const removedCount = initialCount - filtered.length;
        localDevRequests.length = 0;
        localDevRequests.push(...filtered);
        console.log(`\n--- 🧹 [LOCAL DEV: ADMIN CLEAN] Removed ${removedCount} terminated records ---\n`);
        return res.status(200).json({ ok: true, simulated: true, removedCount, remainingCount: filtered.length });
      }

      if (action !== 'auth' && action !== 'deauth') {
        return res.status(400).json({ error: 'Invalid action.' });
      }

      if (!mac) {
        return res.status(400).json({ error: 'MAC address required.' });
      }

      const cleanMac = mac.trim().toLowerCase();
      const dur = action === 'auth' ? parseInt(duration, 10) || 0 : null;
      const cmd = action === 'auth' ? `ndsctl auth ${cleanMac} ${dur}` : `ndsctl deauth ${cleanMac}`;

      localDevQueue.push(cmd);

      // Update in local requests
      const found = localDevRequests.find(r => r.mac.toLowerCase() === cleanMac);
      if (found) {
        found.status = action === 'auth' ? 'authorized' : 'rejected';
        found.duration = dur;
        found.reviewedAt = new Date().toISOString();
        found.reviewedBy = 'Dev Admin';
      } else {
        localDevRequests.unshift({
          name: name || 'Manual Entry',
          mac: cleanMac,
          status: action === 'auth' ? 'authorized' : 'rejected',
          duration: dur,
          requestedAt: new Date().toISOString(),
          reviewedAt: new Date().toISOString(),
          reviewedBy: 'Dev Admin'
        });
      }

      console.log(`\n--- 🛡️ [LOCAL DEV: ADMIN ACTION] ---`);
      console.log(`Action:         ${action.toUpperCase()}`);
      console.log(`MAC:            ${cleanMac}`);
      console.log(`Duration:       ${dur !== null ? (dur === 0 ? 'Unlimited' : `${dur}m`) : 'N/A'}`);
      console.log(`Router Command: ${cmd}`);
      console.log(`Queue Size:     ${localDevQueue.length}`);
      console.log(`------------------------------------\n`);

      return res.status(200).json({
        ok: true,
        success: true,
        simulated: true,
        action,
        mac: cleanMac,
        duration: dur,
        commandQueued: cmd
      });
    }

    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // --- Static File Serving ---
  let filePath;
  if (pathname === '/' || pathname === '/index.html') {
    filePath = path.join(PUBLIC_DIR, 'index.html');
  } else if (pathname === '/admin' || pathname === '/admin.html') {
    filePath = path.join(PUBLIC_DIR, 'admin.html');
  } else if (pathname === '/router' || pathname === '/router/' || pathname === '/router/index.html') {
    filePath = path.join(PUBLIC_DIR, 'router', 'index.html');
  } else {
    filePath = path.join(PUBLIC_DIR, pathname);
  }

  // Security check to avoid path traversal
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.statusCode = 403;
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      // Fallback to index.html for single-page captive portal
      filePath = path.join(PUBLIC_DIR, 'index.html');
    }

    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json',
      '.svg': 'image/svg+xml',
      '.png': 'image/png'
    };

    res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n======================================================`);
  console.log(`🚀 Wi-Fi Captive Portal Dev Server running!`);
  console.log(`🌐 Captive Portal URL:     http://localhost:${PORT}`);
  console.log(`🛡️ Admin Console URL:      http://localhost:${PORT}/admin`);
  console.log(`🔗 openNDS Simulation:     http://localhost:${PORT}/?clientmac=4a:8b:9c:1d:2e:3f&clientip=192.168.1.105&gatewayname=Guest-WiFi`);
  console.log(`======================================================\n`);
});
