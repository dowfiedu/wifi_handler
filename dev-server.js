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
import webhookHandler from './api/webhook.js';
import pollHandler from './api/poll.js';

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

// In-memory queue used for local dev simulation if Upstash Redis credentials are not configured
const localDevQueue = [];

const server = http.createServer(async (req, res) => {
  enhanceResponse(res);

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  // Enable CORS for local testing
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-router-secret');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // --- API Routing ---
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
    console.log('🔘 Buttons simulated: [1 Hour] [3 Hours] [Unlimited] [Reject]');
    console.log('------------------------------------------------------\n');

    if (!name || !mac) {
      return res.status(400).json({ error: 'Field "name" and "mac" are required.' });
    }

    return res.status(200).json({
      success: true,
      simulated: true,
      message: 'Local Simulation: Request stored in database & sent to Telegram (Dev Mode).'
    });
  }

  if (pathname === '/api/webhook') {
    req.body = await parseBody(req);
    if (process.env.TELEGRAM_BOT_TOKEN && process.env.UPSTASH_REDIS_REST_URL) {
      return webhookHandler(req, res);
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

  // --- Static File Serving ---
  let filePath = pathname === '/' ? path.join(PUBLIC_DIR, 'index.html') : path.join(PUBLIC_DIR, pathname);

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

server.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`🚀 Wi-Fi Captive Portal Dev Server running!`);
  console.log(`🌐 Local URL:              http://localhost:${PORT}`);
  console.log(`🔗 openNDS Simulation:     http://localhost:${PORT}/?clientmac=4a:8b:9c:1d:2e:3f&clientip=192.168.1.105&gatewayname=Guest-WiFi`);
  console.log(`======================================================\n`);
});
