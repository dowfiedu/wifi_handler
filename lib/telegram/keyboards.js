/**
 * lib/telegram/keyboards.js
 *
 * Telegram inline and reply keyboard definitions and generators.
 * Kept strictly under 250 lines.
 */

/**
 * Persistent Telegram Reply Keyboard (pinned at the bottom of the chat).
 * High-priority action at top, followed by 2x2 grid layout with is_persistent: true.
 */
export const TELEGRAM_MENU_KEYBOARD = {
  keyboard: [
    [{ text: '➕ ম্যাক অথোরাইজ' }],
    [{ text: '🟢 অ্যাক্টিভ ইউজার' }, { text: '👥 পূর্ববর্তী ইউজার' }],
    [{ text: '📋 ইউজার ডিটেইলস' }, { text: '🧹 ক্লিন চ্যাট ও ডাটা' }]
  ],
  resize_keyboard: true,
  is_persistent: true
};

/**
 * Inline menu keyboard with callback triggers.
 */
export const TELEGRAM_INLINE_MENU = {
  inline_keyboard: [
    [
      { text: '➕ ম্যাক অথোরাইজ', callback_data: 'menu_auth' }
    ],
    [
      { text: '🟢 অ্যাক্টিভ ইউজার', callback_data: 'menu_active' },
      { text: '👥 পূর্ববর্তী ইউজার', callback_data: 'menu_previous' }
    ],
    [
      { text: '📋 ইউজার ডিটেইলস', callback_data: 'menu_details' },
      { text: '🧹 ক্লিন চ্যাট ও ডাটা', callback_data: 'menu_clean' }
    ]
  ]
};

/**
 * Builds inline keyboard buttons to authorize client with preset durations.
 *
 * @param {string} mac
 * @returns {Array<Array<object>>}
 */
export function buildDefaultAuthKeyboard(mac) {
  const cleanMac = (mac || '').toLowerCase().replace(/-/g, ':');
  return [
    [
      { text: '⏱ 10 Mins', callback_data: `auth:${cleanMac}:10` },
      { text: '⏱ 15 Mins', callback_data: `auth:${cleanMac}:15` },
      { text: '⏱ 20 Mins', callback_data: `auth:${cleanMac}:20` }
    ],
    [
      { text: '⏱ 30 Mins', callback_data: `auth:${cleanMac}:30` },
      { text: '⏱ 1 Hour', callback_data: `auth:${cleanMac}:60` }
    ],
    [
      { text: '♾ Unlimited', callback_data: `auth:${cleanMac}:0` },
      { text: '❌ Reject', callback_data: `deauth_${cleanMac}` }
    ]
  ];
}

/**
 * Builds inline keyboard for choosing unlimited sub-options:
 * 1. Session Unlimited (Re-login on next visit / disconnect)
 * 2. Permanent Trusted (Bypasses captive portal permanently)
 * 3. Back button (Restores standard duration keyboard)
 *
 * @param {string} mac
 * @returns {Array<Array<object>>}
 */
export function buildUnlimitedKeyboard(mac) {
  const cleanMac = (mac || '').toLowerCase().replace(/-/g, ':');
  return [
    [{ text: '🔄 এককালীন (পরের বার লগইন পেজ আসবে)', callback_data: `unlim_sess:${cleanMac}` }],
    [{ text: '🛡️ স্থায়ী বিশ্বস্ত (লগইন পেজ আর আসবে না)', callback_data: `unlim_perm:${cleanMac}` }],
    [{ text: '🔙 ফিরে যান', callback_data: `unlim_back:${cleanMac}` }]
  ];
}

/**
 * Builds a single-button inline keyboard to terminate/deauthenticate an active user.
 *
 * @param {string} mac
 * @returns {object}
 */
export function buildSingleUserDeauthKeyboard(mac) {
  const cleanMac = (mac || '').toLowerCase().replace(/-/g, ':');
  return {
    inline_keyboard: [
      [
        { text: '❌ সংযোগ বিচ্ছিন্ন করুন', callback_data: `deauth_${cleanMac}` }
      ]
    ]
  };
}

/**
 * Builds inline keyboard buttons to terminate/deauthenticate active users.
 *
 * @param {Array<object>} activeUsers
 * @returns {object|null}
 */
export function buildActiveUsersKeyboard(activeUsers = []) {
  if (!Array.isArray(activeUsers) || activeUsers.length === 0) {
    return null;
  }

  const buttons = activeUsers.slice(0, 10).map(u => {
    const rawName = (u.name || 'User').trim();
    const shortName = rawName.length > 15 ? rawName.slice(0, 14) + '…' : rawName;
    return [{
      text: `❌ সংযোগ বিচ্ছিন্ন: ${shortName}`,
      callback_data: `deauth_${u.mac}`
    }];
  });

  return { inline_keyboard: buttons };
}
