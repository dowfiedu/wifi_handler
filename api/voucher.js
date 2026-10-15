/**
 * /api/voucher.js
 *
 * Endpoint for voucher code redemption from the captive portal splash page,
 * and voucher management for administrators.
 * Kept strictly under 250 lines.
 */

import { Redis } from '@upstash/redis';
import { redeemVoucher, createVoucher, listActiveVouchers, formatVoucherRedeemedNotice } from '../lib/voucher.js';
import { checkAdminAuth } from '../lib/admin/auth.js';
import { sendTelegramMessage } from '../lib/telegram/client.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Admin-Password');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  if (req.method === 'OPTIONS') {
    return res.status(200).json({ status: 'ok' });
  }

  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!redisUrl || !redisToken) {
    return res.status(500).json({ error: 'Database configuration missing.' });
  }

  const redis = new Redis({ url: redisUrl, token: redisToken });
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  // 1. GET: List active vouchers (Admin only)
  if (req.method === 'GET') {
    const adminPass = process.env.ADMIN_PASSWORD || process.env.ROUTER_SECRET_KEY;
    if (adminPass && !checkAdminAuth(req, adminPass)) {
      return res.status(401).json({ error: 'Unauthorized.' });
    }
    const vouchers = await listActiveVouchers(redis);
    return res.status(200).json({ ok: true, vouchers });
  }

  // 2. POST: Redeem voucher OR Admin creation
  if (req.method === 'POST') {
    let payload = req.body;
    if (typeof payload === 'string') {
      try { payload = JSON.parse(payload); } catch {
        return res.status(400).json({ error: 'Malformed JSON payload.' });
      }
    }
    payload = payload || {};

    // A. Admin creating a voucher
    if (payload.action === 'create') {
      const adminPass = process.env.ADMIN_PASSWORD || process.env.ROUTER_SECRET_KEY;
      if (adminPass && !checkAdminAuth(req, adminPass)) {
        return res.status(401).json({ error: 'Unauthorized.' });
      }
      const duration = parseInt(payload.duration, 10) || 120;
      const voucher = await createVoucher(redis, duration, payload.createdBy || 'Web Admin', payload.note);
      return res.status(200).json({ ok: true, voucher });
    }

    // B. Client redeeming voucher from Captive Portal
    const { code, mac, ip, name } = payload;
    if (!code || !mac) {
      return res.status(400).json({ ok: false, error: 'ভাউচার কোড এবং ম্যাক অ্যাড্রেস প্রদান করুন।' });
    }

    const result = await redeemVoucher(redis, code, mac, ip, name);
    if (!result.ok) {
      return res.status(400).json(result);
    }

    // Send Telegram alert to admin
    if (botToken && chatId) {
      const notice = formatVoucherRedeemedNotice(result.code, result.mac, result.duration, name);
      sendTelegramMessage(botToken, chatId, notice, null, redis).catch(() => {});
    }

    return res.status(200).json(result);
  }

  res.setHeader('Allow', 'GET, POST, OPTIONS');
  return res.status(405).json({ error: `Method ${req.method} Not Allowed.` });
}
