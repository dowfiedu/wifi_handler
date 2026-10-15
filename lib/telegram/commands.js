/**
 * lib/telegram/commands.js
 *
 * Menu command execution and response generation.
 * Kept strictly under 250 lines.
 */

import {
  isUserActive,
  formatSingleActiveUserCard,
  formatActiveUsersList,
  formatPreviousUsersList,
  formatUserDetailsList
} from './cards.js';

import {
  TELEGRAM_MENU_KEYBOARD,
  TELEGRAM_INLINE_MENU,
  buildSingleUserDeauthKeyboard,
  buildActiveUsersKeyboard,
  buildVoucherDurationKeyboard,
  buildSpeedUsersKeyboard
} from './keyboards.js';

import {
  fetchUserRecords,
  cleanTerminatedRecords,
  clearChatHistory
} from './chat-cleaner.js';

import { sendTelegramMessage } from './client.js';
import { generateNetworkReportCard } from './extended-commands.js';

export async function processMenuCommand(command, redis, botToken = null, chatId = null, currentMsgId = null) {
  if (command === 'active' || command === 'dashboard') {
    let liveMacs = null;
    try {
      const rawLiveMacs = await redis.get('router:live_connected_macs');
      if (rawLiveMacs) {
        const parsed = typeof rawLiveMacs === 'string' ? JSON.parse(rawLiveMacs) : rawLiveMacs;
        if (Array.isArray(parsed)) {
          liveMacs = new Set(parsed.map(m => String(m).toLowerCase().replace(/-/g, ':')));
        }
      }
    } catch (e) {
      console.warn('[Live MACs Parse Error]', e);
    }

    const [users, pendingQueueCount] = await Promise.all([
      fetchUserRecords(redis),
      redis.llen('pending_commands').catch(() => 0)
    ]);

    const activeUsers = users.filter(u => {
      if (!isUserActive(u)) return false;
      if (liveMacs) {
        return liveMacs.has((u.mac || '').toLowerCase().replace(/-/g, ':'));
      }
      return true;
    });

    if (botToken && chatId && activeUsers.length > 0) {
      const tz = process.env.APP_TIMEZONE || 'Asia/Dhaka';
      const now = new Date().toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true,
        timeZone: tz
      }) + (tz === 'Asia/Dhaka' ? ' BST' : '');

      const summaryHeader = [
        '🟢 *সক্রিয় নেটওয়ার্ক ইউজার (Active Wi-Fi Users)*',
        '━━━━━━━━━━━━━━━━━━━━',
        `📊 *নেটওয়ার্ক স্ট্যাটাস:* 🟢 সচল | *পেন্ডিং কিউ:* ${Number(pendingQueueCount) || 0} টি`,
        `👥 *মোট কানেক্টেড ইউজার:* ${activeUsers.length} জন`,
        `⏰ *সর্বশেষ লাইভ আপডেট:* ${now}`,
        '━━━━━━━━━━━━━━━━━━━━',
        '_নিচে প্রতিটি সক্রিয় ইউজারের আলাদা কার্ড ও সংযোগ বিচ্ছিন্ন করার বাটন দেওয়া হলো:_'
      ].join('\n');

      await sendTelegramMessage(botToken, chatId, summaryHeader, null, redis);

      for (const u of activeUsers.slice(0, 15)) {
        const cardText = formatSingleActiveUserCard(u);
        const cardKeyboard = buildSingleUserDeauthKeyboard(u.mac);
        await sendTelegramMessage(botToken, chatId, cardText, cardKeyboard, redis);
      }

      return {
        text: null,
        replyMarkup: null,
        ackText: `🟢 অ্যাক্টিভ ইউজার: ${activeUsers.length} জন`
      };
    }

    const text = formatActiveUsersList(activeUsers, Number(pendingQueueCount) || 0);
    const activeKeyboard = buildActiveUsersKeyboard(activeUsers);

    return {
      text,
      replyMarkup: activeKeyboard || TELEGRAM_INLINE_MENU,
      ackText: `🟢 অ্যাক্টিভ ইউজার: ${activeUsers.length} জন`
    };
  }

  if (command === 'previous') {
    const users = await fetchUserRecords(redis);
    const previousUsers = users.filter(u => !isUserActive(u) && u.status !== 'pending');
    const text = formatPreviousUsersList(previousUsers);
    return {
      text,
      replyMarkup: TELEGRAM_INLINE_MENU,
      ackText: `👥 পূর্ববর্তী ইউজার: ${previousUsers.length} জন`
    };
  }

  if (command === 'details') {
    const users = await fetchUserRecords(redis);
    const text = formatUserDetailsList(users);
    const activeUsers = users.filter(u => isUserActive(u));
    const activeKeyboard = buildActiveUsersKeyboard(activeUsers);

    return {
      text,
      replyMarkup: activeKeyboard || TELEGRAM_INLINE_MENU,
      ackText: `📋 ইউজার রেকর্ড: ${users.length} জন`
    };
  }

  if (command === 'clean') {
    if (botToken && chatId) {
      await clearChatHistory(redis, botToken, chatId, currentMsgId);
    }

    const cleanResult = await cleanTerminatedRecords(redis);
    const [users, pendingQueueCount] = await Promise.all([
      fetchUserRecords(redis),
      redis.llen('pending_commands').catch(() => 0)
    ]);
    const activeUsers = users.filter(u => isUserActive(u));

    const cleanNotice = [
      '🧹 *ক্লিন অপারেশন সফলভাবে সম্পন্ন!*',
      '━━━━━━━━━━━━━━━━━━━━',
      '🗑 *চ্যাট হিস্ট্রি:* পূর্ববর্তী সকল বার্তা মুছে দেওয়া হয়েছে।',
      `🗄 *ডাটাবেজ:* ${cleanResult.removedCount} টি টার্মিনেটেড রেকর্ড অপসারণ করা হয়েছে।`,
      `🟢 *বর্তমান সক্রিয় ইউজার:* ${activeUsers.length} জন`,
      `⏳ *পেন্ডিং রাউটার কিউ:* ${Number(pendingQueueCount) || 0} টি`,
      '━━━━━━━━━━━━━━━━━━━━',
      '✨ আপনার কন্ট্রোল প্যানেল এখন সম্পূর্ণ পরিচ্ছন্ন ও প্রস্তুত।',
      '_নিচের মেনুবার থেকে যেকোনো অপশন বেছে নিন।_'
    ].join('\n');

    return {
      text: cleanNotice,
      replyMarkup: TELEGRAM_MENU_KEYBOARD,
      ackText: '🧹 ক্লিন সম্পন্ন! চ্যাট ও ডাটা ফ্রেশ করা হয়েছে'
    };
  }

  if (command === 'auth' || command === 'auth_prompt') {
    const promptMsg = '➕ *সরাসরি MAC অ্যাড্রেস অনুমোদন (Authorize MAC)*\n━━━━━━━━━━━━━━━━━━━━\nযেকোনো ডিভাইসকে (ফোন, ল্যাপটপ, অ্যান্ড্রয়েড টিভি ইত্যাদি) সরাসরি অনুমোদন দিতে তার **MAC Address** লিখে পাঠান।\n\n📌 *উদাহরণ ফরম্যাট:*\n• `46:84:b7:da:39:73`\n• `AA-BB-CC-DD-EE-FF`\n• অথবা: `/auth 46:84:b7:da:39:73`\n\n_💡 MAC এড্রেসটি এখানে পাঠানোর পর কতক্ষণের জন্য এক্সেস দিতে চান তা বেছে নেওয়ার অপশন আসবে।_';
    return {
      text: promptMsg,
      replyMarkup: TELEGRAM_INLINE_MENU,
      ackText: '➕ MAC এড্রেস প্রদান করুন'
    };
  }

  if (command === 'voucher') {
    const voucherPrompt = '🎟️ *অতিথি ভাউচার কোড তৈরি (Guest Voucher)*\n━━━━━━━━━━━━━━━━━━━━\nমেহমানদের জন্য অ্যাডমিনের অনুমতি ছাড়াই সরাসরি ইন্টারনেট ব্যবহারের ওয়ান-টাইম পাসকোড তৈরি করতে নিচের যেকোনো সময়কাল বেছে নিন:\n\n💡 _মেহমান ক্যাপটিভ পোর্টালে এই কোডটি দিলেই তাত্ক্ষণিক ইন্টারনেট পেয়ে যাবেন।_';
    return {
      text: voucherPrompt,
      replyMarkup: { inline_keyboard: buildVoucherDurationKeyboard() },
      ackText: '🎟️ ভাউচারের সময় নির্বাচন করুন'
    };
  }

  if (command === 'speed') {
    const users = await fetchUserRecords(redis);
    const activeUsers = users.filter(u => isUserActive(u));

    if (activeUsers.length === 0) {
      const emptyMsg = '⚡ *ব্যান্ডউইথ স্পিড লিমিট (Bandwidth Throttle)*\n━━━━━━━━━━━━━━━━━━━━\nℹ️ বর্তমানে কোনো সক্রিয় ডিভাইস সংযুক্ত নেই।\n\n📌 *যেকোনো ডিভাইসে স্পিড লিমিট সেট করতে লিখুন:*\n`/limit <MAC> <Mbps>` (যেমন: `/limit 46:84:b7:da:39:73 5`)\n`/limit <MAC> 0` (স্বাভাবিক ফুল স্পিডে ফেরাতে)';
      return { text: emptyMsg, replyMarkup: TELEGRAM_INLINE_MENU, ackText: '⚡ স্পিড লিমিট মেনু' };
    }

    const prompt = '⚡ *ব্যান্ডউইথ স্পিড লিমিট (Bandwidth Throttle)*\n━━━━━━━━━━━━━━━━━━━━\nকোন ডিভাইসের স্পিড নিয়ন্ত্রণ করতে চান? নিচের তালিকা থেকে ডিভাইস সিলেক্ট করুন:';
    return {
      text: prompt,
      replyMarkup: buildSpeedUsersKeyboard(activeUsers),
      ackText: '⚡ ডিভাইস সিলেক্ট করুন'
    };
  }

  if (command === 'report') {
    const text = await generateNetworkReportCard(redis);
    return {
      text,
      replyMarkup: TELEGRAM_INLINE_MENU,
      ackText: '📊 নেটওয়ার্ক রিপোর্ট প্রস্তুত'
    };
  }

  if (command === 'back') {
    return {
      text: '🔘 *প্রধান মেনু:* নিচের অপশনগুলো থেকে বেছে নিন:',
      replyMarkup: TELEGRAM_INLINE_MENU,
      ackText: '🔙 প্রধান মেনু'
    };
  }

  return {
    text: 'ℹ️ কমান্ডটি খুঁজে পাওয়া যায়নি। অনুগ্রহ করে মেনু থেকে নির্বাচন করুন।',
    replyMarkup: TELEGRAM_INLINE_MENU
  };
}
