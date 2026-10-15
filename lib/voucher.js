/**
 * lib/voucher.js
 *
 * Guest Voucher & Passcode Management Engine for Captive Portal.
 * Enables self-service instant access for offline guests without admin delay.
 * Kept strictly under 250 lines.
 */

import { MAC_REGEX } from './telegram/parsers.js';
import { escapeMarkdown } from '../api/request.js';

export function generateVoucherCode(prefix = 'PASS') {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let randomPart = '';
  for (let i = 0; i < 4; i++) {
    randomPart += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `${prefix}-${randomPart}`;
}

export async function createVoucher(redis, durationMinutes = 120, createdBy = 'Admin', note = '') {
  if (!redis) throw new Error('Redis instance is required.');
  const duration = parseInt(durationMinutes, 10);
  const safeDuration = (!isNaN(duration) && duration >= 0) ? duration : 120;
  const code = generateVoucherCode();
  const nowIso = new Date().toISOString();
  const ttlSeconds = 86400 * 3; // Voucher valid to be redeemed within 3 days

  const voucherData = {
    code,
    duration: safeDuration,
    createdBy,
    note: note || '',
    createdAt: nowIso,
    redeemed: 'false',
    redeemedAt: '',
    redeemedByMac: ''
  };

  await redis.hset(`voucher:${code}`, voucherData);
  await redis.expire(`voucher:${code}`, ttlSeconds);
  await redis.sadd('active_vouchers', code);

  return voucherData;
}

export async function redeemVoucher(redis, code, clientMac, clientIp = '', clientName = '') {
  if (!redis || !code || !clientMac) {
    return { ok: false, error: 'ভাউচার কোড এবং ম্যাক অ্যাড্রেস প্রয়োজন।' };
  }

  const cleanCode = String(code).trim().toUpperCase();
  const cleanMac = clientMac.toLowerCase().replace(/-/g, ':');

  if (!MAC_REGEX.test(cleanMac)) {
    return { ok: false, error: 'সঠিক MAC অ্যাড্রেস প্রদান করুন।' };
  }

  const voucher = await redis.hgetall(`voucher:${cleanCode}`);
  if (!voucher || !voucher.code) {
    return { ok: false, error: 'ভাউচার কোডটি সঠিক নয় অথবা মেয়াদ উত্তীর্ণ হয়েছে।' };
  }

  if (voucher.redeemed === 'true') {
    return { ok: false, error: 'এই ভাউচার কোডটি ইতিমধ্যে ব্যবহার করা হয়েছে।' };
  }

  const duration = parseInt(voucher.duration, 10) || 120;
  const nowIso = new Date().toISOString();

  // Mark voucher as redeemed
  await redis.hset(`voucher:${cleanCode}`, {
    redeemed: 'true',
    redeemedAt: nowIso,
    redeemedByMac: cleanMac
  });
  await redis.srem('active_vouchers', cleanCode);

  // Authorize client via OpenWrt queue
  const command = `ndsctl auth ${cleanMac} ${duration}`;
  await redis.rpush('pending_commands', command);

  // Update client status in Redis
  await redis.hset(`request:${cleanMac}`, {
    status: 'authorized',
    duration,
    mode: duration === 0 ? 'session' : 'voucher',
    reviewedBy: `Voucher (${cleanCode})`,
    reviewedAt: nowIso,
    ip: clientIp || '',
    name: clientName || `Guest (${cleanCode})`
  });

  return {
    ok: true,
    code: cleanCode,
    mac: cleanMac,
    duration,
    commandQueued: command,
    message: `ভাউচার কোড সফলভাবে কার্যকর হয়েছে! ${duration === 0 ? 'আনলিমিটেড' : `${duration} মিনিট`} ইন্টারনেট সচল।`
  };
}

export async function listActiveVouchers(redis) {
  if (!redis) return [];
  try {
    const codes = await redis.smembers('active_vouchers');
    if (!Array.isArray(codes) || codes.length === 0) return [];

    const vouchers = await Promise.all(
      codes.map(async (c) => {
        const v = await redis.hgetall(`voucher:${c}`).catch(() => null);
        return v && v.redeemed !== 'true' ? v : null;
      })
    );
    return vouchers.filter(Boolean);
  } catch {
    return [];
  }
}

export function formatVoucherCreatedCard(voucher) {
  const durationText = Number(voucher.duration) === 0 ? '♾ এককালীন আনলিমিটেড' : `⏳ ${voucher.duration} মিনিট`;
  return [
    '🎟️ *নতুন গেস্ট ভাউচার তৈরি হয়েছে!*',
    '━━━━━━━━━━━━━━━━━━━━',
    `🔑 *পাসকোড:* \`${voucher.code}\``,
    `⏱ *মেয়াদ:* ${durationText}`,
    '━━━━━━━━━━━━━━━━━━━━',
    '_💡 মেহমানকে ক্যাপটিভ পোর্টাল পেজে এই কোডটি প্রদান করতে বলুন। কোড দিলেই তাৎক্ষণিক ইন্টারনেট চালু হবে।_'
  ].join('\n');
}

export function formatVoucherRedeemedNotice(code, mac, duration, clientName = 'Guest') {
  const durationText = Number(duration) === 0 ? 'এককালীন আনলিমিটেড' : `${duration} মিনিট`;
  return [
    '🎟️ *গেস্ট ভাউচার দিয়ে লগইন সম্পন্ন*',
    '━━━━━━━━━━━━━━━━━━━━',
    `👤 *ইউজার:* ${escapeMarkdown(clientName)}`,
    `🏷 *MAC:* \`${mac}\``,
    `🔑 *ব্যবহৃত ভাউচার:* \`${code}\``,
    `⏱ *অনুমোদিত সময়:* ${durationText}`,
    '━━━━━━━━━━━━━━━━━━━━',
    '✅ _রাউটার কিউতে অনুমোদন কমান্ড যোগ করা হয়েছে।_'
  ].join('\n');
}
