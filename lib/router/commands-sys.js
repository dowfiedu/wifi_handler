/**
 * lib/router/commands-sys.js
 *
 * Archer C6 system, client, quota, cron, smart-home and raw diagnostic commands.
 * Kept strictly under 250 lines.
 */

import { MAC_REGEX } from '../telegram/parsers.js';
import { isDangerousRouterCommand } from './safety.js';
import { getSimulatedTerminalOutput } from './terminal-sim.js';
import { simState } from './status-sim.js';

export async function handleSystemAndClientCommands(cleanCmd, payload, req, redis) {
  const { target, value } = payload;

  switch (cleanCmd) {
    case 'reboot':
      return { routerCmd: 'reboot' };

    case 'drop_caches':
      return { routerCmd: 'echo 3 > /proc/sys/vm/drop_caches' };

    case 'block_client':
      if (!target || !MAC_REGEX.test(target)) return { error: 'Valid target MAC address required for block_client.', statusCode: 400 };
      return { routerCmd: `iptables -I FORWARD 1 -m mac --mac-source ${target.toLowerCase()} -j DROP` };

    case 'unblock_client':
      if (!target || !MAC_REGEX.test(target)) return { error: 'Valid target MAC address required for unblock_client.', statusCode: 400 };
      return { routerCmd: `iptables -D FORWARD -m mac --mac-source ${target.toLowerCase()} -j DROP` };

    case 'nds_auth': {
      if (!target || !MAC_REGEX.test(target)) return { error: 'Valid target MAC address required for nds_auth.', statusCode: 400 };
      const duration = parseInt(value, 10);
      const safeDuration = !isNaN(duration) && duration >= 0 ? duration : 60;
      return { routerCmd: `ndsctl auth ${target.toLowerCase()} ${safeDuration}` };
    }

    case 'nds_deauth':
    case 'deauth':
      if (!target || !MAC_REGEX.test(target)) return { error: 'Valid target MAC address required for nds_deauth.', statusCode: 400 };
      return { routerCmd: `ndsctl deauth ${target.toLowerCase()}` };

    case 'wol':
      if (!target || !MAC_REGEX.test(target)) return { error: 'Valid target MAC address required for wol.', statusCode: 400 };
      return { routerCmd: `etherwake -i br-lan ${target.toLowerCase()}` };

    case 'set_static_lease': {
      if (!target || !MAC_REGEX.test(target)) return { error: 'Valid target MAC address required for set_static_lease.', statusCode: 400 };
      const ip = value && typeof value === 'string' ? value.trim() : '';
      if (!/^192\.168\.\d+\.\d+$/.test(ip) && !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
        return { error: 'Valid IP address required for set_static_lease.', statusCode: 400 };
      }
      return { routerCmd: `uci set dhcp.host_${target.toLowerCase().replace(/:/g, '')}=host && uci set dhcp.host_${target.toLowerCase().replace(/:/g, '')}.mac='${target.toLowerCase()}' && uci set dhcp.host_${target.toLowerCase().replace(/:/g, '')}.ip='${ip}' && uci commit dhcp` };
    }

    case 'del_static_lease':
      if (!target || !MAC_REGEX.test(target)) return { error: 'Valid target MAC address required for del_static_lease.', statusCode: 400 };
      return { routerCmd: `uci delete dhcp.host_${target.toLowerCase().replace(/:/g, '')} && uci commit dhcp` };

    case 'led_stealth': {
      const brightness = value === 'on' ? '1' : '0';
      return { routerCmd: `for _l in /sys/class/leds/*; do [ -d "$_l" ] && echo ${brightness} > "$_l/brightness" 2>/dev/null; done` };
    }

    case 'set_quota': {
      const quotaGb = parseInt(value, 10) || 50;
      const resetDay = parseInt(req.body?.reset_day || (typeof target === 'number' ? target : 1), 10) || 1;
      const warnPct = parseInt(req.body?.warning_percent || 80, 10) || 80;
      simState.quotaGb = quotaGb;
      simState.quotaResetDay = resetDay;
      simState.quotaWarnPct = warnPct;

      if (globalThis.__localRouterStatus?.analytics?.quota) {
        globalThis.__localRouterStatus.analytics.quota.total_gb = quotaGb;
        globalThis.__localRouterStatus.analytics.quota.reset_day = resetDay;
        globalThis.__localRouterStatus.analytics.quota.warning_percent = warnPct;
      }
      globalThis.__localRouterStatusTimestamp = 0;
      if (redis) {
        try {
          const cached = await redis.get('router:latest_status');
          if (cached) {
            const parsed = typeof cached === 'string' ? JSON.parse(cached) : cached;
            if (parsed.analytics?.quota) {
              parsed.analytics.quota.total_gb = quotaGb;
              parsed.analytics.quota.reset_day = resetDay;
              parsed.analytics.quota.warning_percent = warnPct;
              await redis.set('router:latest_status', JSON.stringify(parsed), { ex: 300 });
            }
          }
        } catch {}
      }
      return { routerCmd: `uci set archer_guard.quota=section && uci set archer_guard.quota.total_gb='${quotaGb}' && uci set archer_guard.quota.reset_day='${resetDay}' && uci set archer_guard.quota.warn_pct='${warnPct}' && uci commit archer_guard` };
    }

    case 'reset_quota': {
      simState.quotaUsedBytes = 0;
      simState.quotaRxBytes = 0;
      simState.quotaTxBytes = 0;
      if (globalThis.__localRouterStatus?.analytics?.quota) {
        globalThis.__localRouterStatus.analytics.quota.used_bytes = 0;
        globalThis.__localRouterStatus.analytics.quota.rx_bytes = 0;
        globalThis.__localRouterStatus.analytics.quota.tx_bytes = 0;
      }
      globalThis.__localRouterStatusTimestamp = 0;
      if (redis) {
        try {
          const cached = await redis.get('router:latest_status');
          if (cached) {
            const parsed = typeof cached === 'string' ? JSON.parse(cached) : cached;
            if (parsed.analytics?.quota) {
              parsed.analytics.quota.used_bytes = 0;
              parsed.analytics.quota.rx_bytes = 0;
              parsed.analytics.quota.tx_bytes = 0;
              await redis.set('router:latest_status', JSON.stringify(parsed), { ex: 300 });
            }
          }
        } catch {}
      }
      return { routerCmd: `wrtbwmon reset || rm -f /tmp/usage.db /tmp/wrtbwmon/usage.db` };
    }

    case 'set_client_quota': {
      if (!target || !MAC_REGEX.test(target)) return { error: 'Valid target MAC address required for set_client_quota.', statusCode: 400 };
      const capGb = parseFloat(value) || 10;
      return { routerCmd: `uci set archer_guard.quota_${target.toLowerCase().replace(/:/g, '')}='${capGb}' && uci commit archer_guard` };
    }

    case 'toggle_cron_task': {
      const task = target && /^[a-zA-Z0-9_-]+$/.test(target) ? target : 'midnight_reboot';
      const enabled = (value === 'on' || value === '1' || value === true);
      let cmd = '/etc/init.d/cron restart';
      if (task === 'midnight_reboot') {
        cmd = enabled ? `echo '0 4 * * * /sbin/reboot' >> /etc/crontabs/root && /etc/init.d/cron restart` : `sed -i '/\\/sbin\\/reboot/d' /etc/crontabs/root && /etc/init.d/cron restart`;
      } else if (task === 'wifi_sleep') {
        cmd = enabled ? `echo '0 1 * * * /sbin/wifi down' >> /etc/crontabs/root && echo '0 7 * * * /sbin/wifi up' >> /etc/crontabs/root && /etc/init.d/cron restart` : `sed -i '/wifi[[:space:]]\\+down/d' /etc/crontabs/root && sed -i '/wifi[[:space:]]\\+up/d' /etc/crontabs/root && /etc/init.d/cron restart`;
      } else if (task === 'nightly_flush') {
        cmd = enabled ? `echo '30 3 * * * sync && echo 3 > /proc/sys/vm/drop_caches' >> /etc/crontabs/root && /etc/init.d/cron restart` : `sed -i '/drop_caches/d' /etc/crontabs/root && /etc/init.d/cron restart`;
      }
      return { routerCmd: cmd };
    }

    case 'set_cron_schedule': {
      const expr = (target && typeof target === 'string') ? target.replace(/['"\\]/g, '') : '0 4 * * *';
      const cmd = (value && typeof value === 'string') ? value.replace(/['"\\]/g, '') : '/sbin/reboot';
      return { routerCmd: `echo '${expr} ${cmd}' >> /etc/crontabs/root && /etc/init.d/cron restart` };
    }

    case 'set_homeassistant_webhook': {
      const webhookUrl = (value && typeof value === 'string') ? value.replace(/['"\\]/g, '') : '';
      const enabled = req.body?.enabled !== false ? '1' : '0';
      return { routerCmd: `uci set archer_guard.ha=section && uci set archer_guard.ha.enabled='${enabled}' && uci set archer_guard.ha.webhook='${webhookUrl}' && uci commit archer_guard` };
    }

    case 'trigger_ha_webhook': {
      const webhookUrl = (req.body?.webhook_url && typeof req.body.webhook_url === 'string') ? req.body.webhook_url.replace(/['"\\]/g, '') : 'http://homeassistant.local:8123/api/webhook/archer_c6_presence';
      const mac = target && MAC_REGEX.test(target) ? target.toLowerCase() : '3c:22:fb:1a:2b:3c';
      const state = value === 'disconnected' ? 'disconnected' : 'connected';
      return { routerCmd: `curl -s -m 3 -X POST -H 'Content-Type: application/json' -d '{"device":"archer_c6","mac":"${mac}","state":"${state}"}' '${webhookUrl}'` };
    }

    case 'raw_cmd': {
      const rawCmd = (value && typeof value === 'string') ? value.trim() : (target && typeof target === 'string' ? target.trim() : 'uptime');
      if (isDangerousRouterCommand(rawCmd)) {
        return {
          error: 'SAFETY LOCK ACTIVATED: This command contains operations that could damage firmware or disrupt LAN access.',
          blocked: true,
          command: cleanCmd,
          statusCode: 403
        };
      }
      return { routerCmd: rawCmd, simulatedOutput: getSimulatedTerminalOutput(rawCmd) };
    }

    case 'backup_config':
      return { routerCmd: `sysupgrade -b /tmp/backup-OpenWrt-c6.tar.gz || tar -czf /tmp/backup-OpenWrt-c6.tar.gz -C / etc/config etc/shadow` };

    default:
      return null;
  }
}
