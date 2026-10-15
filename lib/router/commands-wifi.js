/**
 * lib/router/commands-wifi.js
 *
 * Archer C6 Wi-Fi, radio, SQM, DNS and network commands.
 * Kept strictly under 250 lines.
 */

import { simState } from './status-sim.js';

export function handleWifiAndNetworkCommands(cleanCmd, payload, req) {
  const { target, value, extra } = payload;

  switch (cleanCmd) {
    case 'wifi_toggle': {
      const radio = target && /^[a-zA-Z0-9_-]+$/.test(target) ? target : 'radio0';
      const disabled = value === 'off' ? '1' : '0';
      return { routerCmd: `uci set wireless.${radio}.disabled='${disabled}' && uci commit wireless && wifi reload` };
    }

    case 'set_txpower': {
      const radio = target && /^[a-zA-Z0-9_-]+$/.test(target) ? target : 'radio0';
      const dbm = parseInt(value, 10);
      const safeDbm = !isNaN(dbm) && dbm >= 1 && dbm <= 30 ? dbm : 20;
      return { routerCmd: `uci set wireless.${radio}.txpower='${safeDbm}' && uci commit wireless && wifi reload` };
    }

    case 'set_wifi_channel': {
      const radio = target && /^[a-zA-Z0-9_-]+$/.test(target) ? target : 'radio0';
      const chan = parseInt(value, 10);
      const safeChan = !isNaN(chan) && chan >= 0 && chan <= 165 ? chan : 0;
      return { routerCmd: `uci set wireless.${radio}.channel='${safeChan}' && uci commit wireless && wifi reload` };
    }

    case 'set_wifi_htmode': {
      const radio = target && /^[a-zA-Z0-9_-]+$/.test(target) ? target : 'radio0';
      const allowed = ['HT20', 'HT40', 'VHT20', 'VHT40', 'VHT80', 'NOHT'];
      const safeMode = allowed.includes(value) ? value : 'HT20';
      return { routerCmd: `uci set wireless.${radio}.htmode='${safeMode}' && uci commit wireless && wifi reload` };
    }

    case 'set_wifi_ssid': {
      const iface = target && /^[a-zA-Z0-9_@.-]+$/.test(target) ? target : 'default_radio0';
      const cleanSsid = typeof value === 'string' ? value.replace(/['"\\]/g, '').substring(0, 32) : 'Archer_C6';
      let extraCmds = '';
      if (extra && extra.key && typeof extra.key === 'string') {
        const cleanKey = extra.key.replace(/['"\\]/g, '').substring(0, 64);
        extraCmds += ` && uci set wireless.${iface}.key='${cleanKey}'`;
      }
      if (extra && extra.hidden !== undefined) {
        const hidVal = (extra.hidden === '1' || extra.hidden === 1 || extra.hidden === true) ? '1' : '0';
        extraCmds += ` && uci set wireless.${iface}.hidden='${hidVal}'`;
      }
      return { routerCmd: `uci set wireless.${iface}.ssid='${cleanSsid}'${extraCmds} && uci commit wireless && wifi reload` };
    }

    case 'add_wifi_ssid': {
      const rad = target && /^[a-zA-Z0-9_-]+$/.test(target) ? target : 'radio0';
      const cleanSsid = typeof value === 'string' ? value.replace(/['"\\]/g, '').substring(0, 32) : 'New_SSID';
      const sec = `ap_${cleanSsid.replace(/[^a-zA-Z0-9_]/g, '').substring(0, 10)}`;
      return { routerCmd: `uci set wireless.${sec}=wifi-iface && uci set wireless.${sec}.device='${rad}' && uci set wireless.${sec}.mode='ap' && uci set wireless.${sec}.network='lan' && uci set wireless.${sec}.ssid='${cleanSsid}' && uci set wireless.${sec}.encryption='psk2' && uci commit wireless && wifi reload` };
    }

    case 'del_wifi_ssid': {
      const sec = target && /^[a-zA-Z0-9_@.-]+$/.test(target) ? target : '';
      return sec ? { routerCmd: `uci delete wireless.${sec} && uci commit wireless && wifi reload` } : { routerCmd: '' };
    }

    case 'toggle_wifi_ssid': {
      const sec = target && /^[a-zA-Z0-9_@.-]+$/.test(target) ? target : 'default_radio0';
      const disabled = (value === 'off' || value === '0' || value === false) ? '1' : '0';
      return { routerCmd: `uci set wireless.${sec}.disabled='${disabled}' && uci commit wireless && wifi reload` };
    }

    case 'guest_wifi_toggle': {
      const disabled = (value === 'on' || value === '1' || value === true) ? '0' : '1';
      return { routerCmd: `uci set wireless.guest.disabled='${disabled}' && uci commit wireless && wifi reload` };
    }

    case 'set_wifi_advanced': {
      const opt = target && /^[a-zA-Z0-9_-]+$/.test(target) ? target : 'roaming';
      const flag = (value === 'on' || value === '1' || value === true) ? '1' : '0';
      return { routerCmd: `uci set wireless.@wifi-iface[0].${opt}='${flag}' && uci commit wireless && wifi reload` };
    }

    case 'set_hw_offload': {
      const flag = (value === 'on' || value === '1' || value === true) ? '1' : '0';
      return { routerCmd: `uci set firewall.@defaults[0].flow_offloading='${flag}' && uci set firewall.@defaults[0].flow_offloading_hw='0' && uci commit firewall && /etc/init.d/firewall restart` };
    }

    case 'set_sqm': {
      const flag = (value === 'on' || value === '1' || value === true) ? '1' : '0';
      return { routerCmd: `uci set sqm.@queue[0].enabled='${flag}' && uci commit sqm && /etc/init.d/sqm restart` };
    }

    case 'set_sqm_limits': {
      const qdisc = (target && ['cake', 'fq_codel'].includes(target))
        ? target
        : (req.body?.qdisc && ['cake', 'fq_codel'].includes(req.body.qdisc) ? req.body.qdisc : 'cake');
      let parsedVal = value;
      if (typeof value === 'string' && value.startsWith('{')) {
        try { parsedVal = JSON.parse(value); } catch (_) {}
      }
      const dl = parseInt(parsedVal && typeof parsedVal === 'object' ? parsedVal.download : (req.body?.download || value), 10) || 95000;
      const ul = parseInt(parsedVal && typeof parsedVal === 'object' ? parsedVal.upload : (req.body?.upload || target), 10) || 20000;
      return { routerCmd: `uci set sqm.@queue[0].qdisc='${qdisc}' && uci set sqm.@queue[0].download='${dl}' && uci set sqm.@queue[0].upload='${ul}' && uci commit sqm && /etc/init.d/sqm restart` };
    }

    case 'set_wireguard': {
      const active = (value === 'on' || value === '1' || value === true);
      return { routerCmd: active ? 'ifup wg0' : 'ifdown wg0' };
    }

    case 'set_multiwan': {
      const flag = (value === 'on' || value === '1' || value === true) ? '1' : '0';
      const action = flag === '1' ? 'restart' : 'stop';
      return { routerCmd: `uci set mwan3.globals.enabled='${flag}' && uci commit mwan3 && /etc/init.d/mwan3 ${action}` };
    }

    case 'set_doh': {
      const flag = (value === 'on' || value === '1' || value === true) ? '1' : '0';
      const action = flag === '1' ? 'start' : 'stop';
      return { routerCmd: `/etc/init.d/https-dns-proxy ${action}` };
    }

    case 'set_dns': {
      const primary = (req.body?.primary || value || '').trim();
      const secondary = (req.body?.secondary || target || '').trim();
      const ipv4Regex = /^([0-9]{1,3}\.){3}[0-9]{1,3}$/;
      if (primary && primary !== 'auto') {
        if (!ipv4Regex.test(primary) || (secondary && !ipv4Regex.test(secondary))) {
          return { error: 'Invalid DNS IP address format.', statusCode: 400 };
        }
        const list = [primary];
        if (secondary) list.push(secondary);
        const uciList = list.map(d => `uci add_list network.wan.dns='${d}'`).join(' && ');
        simState.customDns = list.join(', ');
        if (globalThis.__localRouterStatus?.network?.wan_details) {
          globalThis.__localRouterStatus.network.wan_details.dns = simState.customDns;
        }
        return { routerCmd: `uci set network.wan.peerdns='0' && uci delete network.wan.dns 2>/dev/null && ${uciList} && uci commit network && /etc/init.d/network reload` };
      }
      simState.customDns = null;
      if (globalThis.__localRouterStatus?.network?.wan_details) {
        globalThis.__localRouterStatus.network.wan_details.dns = '1.1.1.1, 8.8.8.8';
      }
      return { routerCmd: `uci set network.wan.peerdns='1' && uci delete network.wan.dns 2>/dev/null && uci commit network && /etc/init.d/network reload` };
    }

    case 'set_smp_steering': {
      const enabled = (value === '1' || value === 'true' || value === 'on');
      return {
        routerCmd: enabled
          ? `for q in /sys/class/net/*/queues/rx-*/rps_cpus; do [ -e "$q" ] && echo "f" > "$q" 2>/dev/null; done && uci set system.@system[0].smp_steering='1' && uci commit system`
          : `for q in /sys/class/net/*/queues/rx-*/rps_cpus; do [ -e "$q" ] && echo "0" > "$q" 2>/dev/null; done && uci set system.@system[0].smp_steering='0' && uci commit system`
      };
    }

    case 'set_wps_action': {
      const action = (value && typeof value === 'string') ? value.replace(/['"\\]/g, '') : 'Toggle 5G Wi-Fi';
      return { routerCmd: `uci set system.@system[0].wps_action='${action}' && uci commit system` };
    }

    default:
      return null;
  }
}
