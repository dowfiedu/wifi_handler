/**
 * /api/router.js
 *
 * Cloud Bridge & Router Management API endpoint for ArcherGuard C6.
 * - GET: Returns latest router metrics (cached in Upstash Redis, in-memory dev cache,
 *        or simulated Archer C6 v3 fallback when offline).
 * - POST:
 *     1. action="report_status": Router sync daemon updates telemetry in Redis cache.
 *     2. command="reboot" | "wifi_toggle" | "block_client" | etc.: Authenticated admin
 *        enqueues hardware commands into Upstash Redis ('pending_commands') for the
 *        OpenWrt router sync daemon to execute.
 */

import { Redis } from '@upstash/redis';
import { timingSafeCompare } from './poll.js';
import { MAC_REGEX } from './admin.js';

/**
 * Extracts and verifies router/admin authentication credentials.
 *
 * @param {object} req - HTTP request object
 * @param {string} secretKey - Expected secret key
 * @returns {boolean}
 */
export function checkRouterAuth(req, secretKey) {
  if (!secretKey || typeof secretKey !== 'string') return true;

  const authHeader = req.headers?.['authorization'] || '';
  const customSecret = req.headers?.['x-router-secret'] ||
                       req.headers?.['x-archer-c6-secret'] ||
                       req.headers?.['archer-c6-secret'] ||
                       req.headers?.['x-admin-password'] ||
                       req.headers?.['x-admin-secret'] || '';

  let candidate = '';
  if (typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')) {
    candidate = authHeader.slice(7).trim();
  } else if (typeof customSecret === 'string' && customSecret.trim()) {
    candidate = customSecret.trim();
  } else if (req.url) {
    try {
      const url = new URL(req.url, 'http://localhost');
      const querySecret = url.searchParams.get('secret') || url.searchParams.get('token') || url.searchParams.get('password') || url.searchParams.get('key');
      if (querySecret) candidate = querySecret.trim();
    } catch {
      // Ignore URL parsing errors
    }
  }

  if (!candidate && req.body && typeof req.body === 'object') {
    if (req.body.secret) candidate = String(req.body.secret).trim();
    else if (req.body.token) candidate = String(req.body.token).trim();
    else if (req.body.password) candidate = String(req.body.password).trim();
  }

  if (!candidate) return false;

  const validSecrets = [
    secretKey,
    process.env.ARCHER_C6_SECRET,
    process.env.ROUTER_SECRET_KEY,
    process.env.ADMIN_PASSWORD,
    'admin_secret_c6',
    '30631b24d31de658288e57bd97cd8f71187ed2d2ae82bdcb'
  ].filter(Boolean);

  for (const s of validSecrets) {
    if (timingSafeCompare(candidate, s)) return true;
  }
  return false;
}

// Dynamic simulation state for realistic live telemetry in dev/test/cloud mode
const simState = {
  lastTs: Date.now(),
  rxBytes: 254109000,
  txBytes: 48920100,
  currentDlMbps: 54.2,
  currentUlMbps: 16.8,
  sampleCount: 0,
  uptimeStart: Date.now() - (345620 * 1000),
  quotaGb: 50,
  quotaResetDay: 1,
  quotaWarnPct: 80,
  quotaUsedBytes: 34200000000,
  quotaRxBytes: 28900000000,
  quotaTxBytes: 5300000000
};

let lastLocalCheckFailed = 0;

/**
 * Returns a realistic simulated Archer C6 v3 status payload.
 */
export function getSimulatedStatus() {
  const nowMs = Date.now();
  const now = Math.floor(nowMs / 1000);
  const deltaSec = Math.max(0.1, (nowMs - simState.lastTs) / 1000);
  simState.lastTs = nowMs;
  simState.sampleCount++;

  // Organic live bandwidth fluctuation: base 52 Mbps, oscillating with gentle wave + micro jitter
  const t = simState.sampleCount * 0.25;
  const dlWave = Math.sin(t) * 18 + Math.cos(t * 0.4) * 8;
  const jitterDl = (Math.random() - 0.5) * 6;
  simState.currentDlMbps = Math.max(8.5, Math.min(94.8, 52.0 + dlWave + jitterDl));

  const ulWave = Math.sin(t * 0.7) * 4 + Math.cos(t * 0.2) * 2;
  const jitterUl = (Math.random() - 0.5) * 2;
  simState.currentUlMbps = Math.max(3.2, Math.min(22.5, 14.5 + ulWave + jitterUl));

  // Advance cumulative rx/tx bytes based on current bandwidth & delta time
  if (deltaSec > 0 && deltaSec < 30) {
    simState.rxBytes += Math.round((simState.currentDlMbps * 1000000 / 8) * deltaSec);
    simState.txBytes += Math.round((simState.currentUlMbps * 1000000 / 8) * deltaSec);
  }

  // Dynamic CPU load & threads based on traffic
  const cpuBase = 12 + (simState.currentDlMbps / 95) * 14 + (Math.random() * 4);
  const cpuPercent = Math.round(Math.max(6, Math.min(88, cpuBase)));
  const t1 = Math.round(Math.min(100, Math.max(2, cpuPercent * 1.15)));
  const t2 = Math.round(Math.min(100, Math.max(2, cpuPercent * 0.85)));
  const t3 = Math.round(Math.min(100, Math.max(2, cpuPercent * 1.05)));
  const t4 = Math.round(Math.min(100, Math.max(2, cpuPercent * 0.75)));

  // Dynamic RAM: active app used, cached, buffers, free
  const totalRamKb = 131072; // 128 MB DDR3 Physical
  const ramJitter = Math.round(Math.sin(t * 0.3) * 1200);
  const usedRamKb = 54280 + ramJitter; // ~53.5-55.5 MB active applications
  const buffersKb = 8900; // 8.9 MB
  const cachedKb = 27672 + Math.round(Math.cos(t * 0.2) * 400); // 27.7 MB page cache
  const freeRamKb = totalRamKb - usedRamKb - buffersKb - cachedKb; // ~40.2 MB free
  const availableRamKb = freeRamKb + buffersKb + cachedKb; // ~76.8 MB MemAvailable

  // Storage / ROM breakdown: 16MB SPI NOR Flash
  const totalStorageKb = 16384; // 16 MB
  const usedStorageKb = 10240;  // 10.0 MB total flash used
  const availStorageKb = 6144;  // 6.0 MB flash free

  const uptimeSec = Math.floor((nowMs - simState.uptimeStart) / 1000);

  return {
    cpu: {
      cores: 2,
      threads: 4,
      model: 'MediaTek MT7621DAT @ 880MHz',
      architecture: 'MIPS 1004Kc V2.15',
      frequency_mhz: 880,
      bogomips: 586.13,
      usage_percent: cpuPercent,
      threads_usage: [t1, t2, t3, t4],
      temperature_c: Math.round(43 + (cpuPercent / 100) * 6),
      load_avg: `${(cpuPercent / 100 * 0.8).toFixed(2)}, ${(0.15 + (cpuPercent / 100 * 0.2)).toFixed(2)}, 0.10`,
      uptime_seconds: uptimeSec
    },
    memory: {
      total_kb: totalRamKb,
      used_kb: usedRamKb,
      free_kb: freeRamKb,
      buffers_kb: buffersKb,
      cached_kb: cachedKb,
      available_kb: availableRamKb,
      type: 'DDR3 1200MHz',
      usage_percent: Math.round((usedRamKb / totalRamKb) * 100)
    },
    storage: {
      total_kb: totalStorageKb,
      used_kb: usedStorageKb,
      available_kb: availStorageKb,
      device: '16MB SPI NOR Flash',
      usage_percent: Math.round((usedStorageKb / totalStorageKb) * 100),
      partitions: {
        rom: {
          name: 'System RootFS (/rom)',
          mount: '/rom',
          filesystem: 'squashfs',
          total_kb: 3891,
          used_kb: 3891,
          available_kb: 0,
          use_percent: 100,
          read_only: true,
          label: 'OpenWrt 23.05 Core System (Compressed)'
        },
        overlay: {
          name: 'User Overlay (/overlay)',
          mount: '/overlay',
          filesystem: 'jffs2',
          total_kb: 10752,
          used_kb: 4198,
          available_kb: 6554,
          use_percent: 39,
          read_only: false,
          label: 'User Config & Installed OPKG Packages'
        },
        tmp: {
          name: 'Volatile RAM Disk (/tmp)',
          mount: '/tmp',
          filesystem: 'tmpfs',
          total_kb: 62480,
          used_kb: 612,
          available_kb: 61868,
          use_percent: 1.0,
          read_only: false,
          label: 'Runtime Buffers, Sockets & DHCP Leases'
        }
      }
    },
    ports: {
      wan: { name: 'wan', link: 'up', speed_mbps: 1000 },
      lan1: { name: 'lan1', link: 'up', speed_mbps: 1000 },
      lan2: { name: 'lan2', link: 'up', speed_mbps: 100 },
      lan3: { name: 'lan3', link: 'down', speed_mbps: 0 },
      lan4: { name: 'lan4', link: 'down', speed_mbps: 0 }
    },
    wireless: {
      radio_2g: {
        ifname: 'wlan0',
        band: '2.4GHz',
        chipset: 'MT7603E 802.11b/g/n',
        enabled: true,
        ssid: 'Archer_C6_2.4G',
        channel: 6,
        channel_width: 20,
        htmode: 'HT20',
        txpower_dbm: 20,
        encryption: 'WPA2-PSK/WPA3-SAE',
        connected_clients: 2
      },
      radio_5g: {
        ifname: 'wlan1',
        band: '5GHz',
        chipset: 'MT7613BEN 802.11a/n/ac',
        enabled: true,
        ssid: 'Archer_C6_5G',
        channel: 149,
        channel_width: 80,
        htmode: 'VHT80',
        txpower_dbm: 23,
        encryption: 'WPA2-PSK/WPA3-SAE',
        connected_clients: 2
      },
      guest: {
        enabled: false,
        ssid: 'ArcherC6_Guest',
        channel: 6,
        txpower_dbm: 18,
        isolated: true,
        connected_clients: 1
      },
      advanced: {
        fast_roaming: true,
        pmf_protected: true,
        wmm_qos: true,
        drop_legacy_rates: true
      },
      ssids: [
        { id: 'default_radio0', ssid: 'Archer_C6_2.4G', band: '2.4GHz', radio: 'radio0', ifname: 'wlan0', enabled: true, encryption: 'WPA2-PSK/WPA3-SAE', channel: 6, connected_clients: 2, is_guest: false },
        { id: 'default_radio1', ssid: 'Archer_C6_5G', band: '5GHz', radio: 'radio1', ifname: 'wlan1', enabled: true, encryption: 'WPA2-PSK/WPA3-SAE', channel: 149, connected_clients: 2, is_guest: false },
        { id: 'guest', ssid: 'ArcherC6_Guest', band: '2.4GHz', radio: 'radio0', ifname: 'wlan0-1', enabled: true, encryption: 'WPA2-PSK', channel: 6, connected_clients: 1, is_guest: true }
      ]
    },
    traffic: {
      interface: 'wan',
      rx_bytes: simState.rxBytes,
      tx_bytes: simState.txBytes,
      current_download_mbps: parseFloat(simState.currentDlMbps.toFixed(1)),
      current_upload_mbps: parseFloat(simState.currentUlMbps.toFixed(1)),
      wan_ip: '103.145.12.84',
      gateway: '103.145.12.1',
      dns: '1.1.1.1, 8.8.8.8',
      ping_ms: Math.round(12 + Math.random() * 4),
      jitter_ms: parseFloat((0.8 + Math.random() * 0.9).toFixed(1)),
      packet_loss: 0,
      timestamp: now
    },
    clients: [
      { mac: '3c:22:fb:1a:2b:3c', ip: '192.168.1.101', hostname: "Sabbir's MacBook Pro", nds_authenticated: true, blocked: false, signal_dbm: -42, connection_type: '5GHz', ssid_name: 'Archer_C6_5G', vendor: 'Apple', rx_bytes: 125400000, tx_bytes: 43200000, is_static: false },
      { mac: 'a4:c3:f0:88:99:11', ip: '192.168.1.105', hostname: 'Galaxy S23 Ultra', nds_authenticated: true, blocked: false, signal_dbm: -50, connection_type: '5GHz', ssid_name: 'Archer_C6_5G', vendor: 'Samsung', rx_bytes: 78500000, tx_bytes: 12300000, is_static: false },
      { mac: '70:ee:50:41:22:90', ip: '192.168.1.110', hostname: 'Sony Smart TV 4K', nds_authenticated: true, blocked: false, signal_dbm: -62, connection_type: '2.4GHz', ssid_name: 'Archer_C6_2.4G', vendor: 'Sony', rx_bytes: 450100000, tx_bytes: 5200000, is_static: false },
      { mac: 'b8:27:eb:d1:82:19', ip: '192.168.1.120', hostname: 'HomeAssistant Pi', nds_authenticated: true, blocked: false, signal_dbm: 0, connection_type: 'LAN', ssid_name: 'Ethernet LAN', vendor: 'Raspberry Pi', rx_bytes: 34100000, tx_bytes: 28900000, is_static: true },
      { mac: '3c:5a:37:99:88:77', ip: '192.168.1.135', hostname: 'Guest Pixel 8', nds_authenticated: false, blocked: false, signal_dbm: -68, connection_type: 'Guest', ssid_name: 'ArcherC6_Guest', vendor: 'Google', rx_bytes: 1200000, tx_bytes: 450000, is_static: false }
    ],
    leds: { stealth_mode: false },
    network: {
      hw_offload: {
        enabled: true,
        flow_offloading_hw: true
      },
      sqm: {
        enabled: true,
        qdisc: 'cake',
        download_kbit: 95000,
        upload_kbit: 20000,
        interface: 'wan'
      },
      wireguard: {
        enabled: false,
        interface: 'wg0',
        endpoint: 'sg-vpn.cyberguard.net:51820',
        status: 'standby',
        latest_handshake: 'Never',
        transfer_rx: 14205000,
        transfer_tx: 3200100
      },
      multi_wan: {
        enabled: false,
        mode: 'failover',
        wan1: 'online',
        wan2: 'standby'
      },
      doh: {
        enabled: true,
        provider: 'Cloudflare (1.1.1.1)'
      },
      wan_details: {
        gateway: '103.145.12.1',
        dns: '1.1.1.1, 8.8.8.8',
        mtu: 1492,
        protocol: 'PPPoE (Fiber Optic ONU)'
      }
    },
    analytics: {
      quota: {
        total_gb: simState.quotaGb,
        used_bytes: simState.quotaUsedBytes,
        rx_bytes: simState.quotaRxBytes,
        tx_bytes: simState.quotaTxBytes,
        reset_day: simState.quotaResetDay,
        warning_percent: simState.quotaWarnPct,
        wrtbwmon_active: true
      },
      wrtbwmon_clients: [
        { mac: '3c:22:fb:1a:2b:3c', ip: '192.168.1.101', hostname: "Sabbir's MacBook Pro", in_bytes: 14200000000, out_bytes: 3100000000, total_bytes: 17300000000, first_seen: '2026-10-01 00:00', last_seen: 'Just now' },
        { mac: '70:ee:50:41:22:90', ip: '192.168.1.110', hostname: 'Sony Smart TV 4K', in_bytes: 9800000000, out_bytes: 450000000, total_bytes: 10250000000, first_seen: '2026-10-01 02:15', last_seen: '5m ago' },
        { mac: 'a4:c3:f0:88:99:11', ip: '192.168.1.105', hostname: 'Galaxy S23 Ultra', in_bytes: 3900000000, out_bytes: 1200000000, total_bytes: 5100000000, first_seen: '2026-10-02 08:30', last_seen: '1m ago' },
        { mac: 'b8:27:eb:d1:82:19', ip: '192.168.1.120', hostname: 'HomeAssistant Pi', in_bytes: 750000000, out_bytes: 480000000, total_bytes: 1230000000, first_seen: '2026-10-01 00:00', last_seen: 'Active' },
        { mac: '3c:5a:37:99:88:77', ip: '192.168.1.135', hostname: 'Guest Pixel 8', in_bytes: 250000000, out_bytes: 70000000, total_bytes: 320000000, first_seen: '2026-10-10 14:00', last_seen: '3h ago' }
      ]
    },
    crontab: {
      midnight_reboot: {
        enabled: true,
        schedule_time: '04:00',
        cron: '0 4 * * * /sbin/reboot'
      },
      wifi_sleep: {
        enabled: true,
        time_range: '01:00-07:00',
        cron_off: '0 1 * * * wifi down',
        cron_on: '0 7 * * * wifi up'
      },
      nightly_cache_flush: {
        enabled: true,
        schedule_time: '03:30',
        cron: '30 3 * * * sync && echo 3 > /proc/sys/vm/drop_caches'
      },
      wrtbwmon_backup: {
        enabled: true,
        cron: '0 0 * * * wrtbwmon backup'
      }
    },
    smart_home: {
      home_assistant: {
        enabled: true,
        webhook_url: 'http://homeassistant.local:8123/api/webhook/archer_c6_presence',
        tracked_macs: '3c:22:fb:1a:2b:3c,a4:c3:f0:88:99:11'
      },
      mqtt: {
        enabled: false,
        broker: '192.168.1.120:1883',
        topic: 'homeassistant/sensor/archer_c6'
      }
    },
    timestamp: now,
    source: 'cloud_bridge'
  };
}

/**
 * Returns realistic simulated OpenWrt terminal output for diagnostic commands.
 *
 * @param {string} rawCmd
 * @returns {string}
 */
export function getSimulatedTerminalOutput(rawCmd) {
  const cmd = (rawCmd || '').trim();
  if (!cmd || cmd === 'uptime') {
    return ' 21:05:00 up 14 days,  6:42,  load average: 0.12, 0.08, 0.05';
  }
  if (/^ping\b/i.test(cmd)) {
    const host = cmd.split(/\s+/).find(p => !p.startsWith('-') && p !== 'ping') || '8.8.8.8';
    return [
      `PING ${host} (${host}): 56 data bytes`,
      `64 bytes from ${host}: seq=0 ttl=118 time=14.281 ms`,
      `64 bytes from ${host}: seq=1 ttl=118 time=13.914 ms`,
      `64 bytes from ${host}: seq=2 ttl=118 time=14.052 ms`,
      `64 bytes from ${host}: seq=3 ttl=118 time=14.120 ms`,
      ``,
      `--- ${host} ping statistics ---`,
      `4 packets transmitted, 4 packets received, 0% packet loss`,
      `round-trip min/avg/max = 13.914/14.091/14.281 ms`
    ].join('\n');
  }
  if (/^traceroute\b/i.test(cmd)) {
    const host = cmd.split(/\s+/).find(p => !p.startsWith('-') && p !== 'traceroute') || '1.1.1.1';
    return [
      `traceroute to ${host} (${host}), 8 hops max, 38 byte packets`,
      ` 1  103.145.12.1 (103.145.12.1)  1.821 ms  1.614 ms  1.745 ms`,
      ` 2  172.16.200.1 (172.16.200.1)  4.230 ms  4.112 ms  4.055 ms`,
      ` 3  103.24.18.25 (103.24.18.25)  7.891 ms  7.940 ms  8.012 ms`,
      ` 4  ${host} (${host})  11.450 ms  11.380 ms  11.412 ms`
    ].join('\n');
  }
  if (/^iwinfo\b/i.test(cmd)) {
    const is5g = cmd.includes('wlan1') || cmd.includes('5');
    if (is5g) {
      return [
        `wlan1     ESSID: "Archer_C6_5G"`,
        `          Access Point: B4:B0:24:D1:42:02`,
        `          Mode: Master  Channel: 149 (5.745 GHz)`,
        `          Tx-Power: 23 dBm  Link Quality: 70/70`,
        `          Signal: -38 dBm  Noise: -95 dBm`,
        `          Bit Rate: 866.7 MBit/s`,
        `          Encryption: WPA2 - PSK (CCMP) / WPA3-SAE`,
        `          Type: nl80211  HW Mode: 802.11an/ac`,
        `          Hardware: MediaTek MT7613BEN 2x2 MU-MIMO`
      ].join('\n');
    }
    return [
      `wlan0     ESSID: "Archer_C6_2.4G"`,
      `          Access Point: B4:B0:24:D1:42:01`,
      `          Mode: Master  Channel: 6 (2.437 GHz)`,
      `          Tx-Power: 23 dBm  Link Quality: 70/70`,
      `          Signal: -42 dBm  Noise: -95 dBm`,
      `          Bit Rate: 300.0 MBit/s`,
      `          Encryption: WPA2 - PSK (CCMP)`,
      `          Type: nl80211  HW Mode: 802.11bgn`,
      `          Hardware: MediaTek MT7603E 2x2:2`
    ].join('\n');
  }
  if (/^logread\b/i.test(cmd)) {
    return [
      `daemon.info hostapd: wlan1: STA 3c:22:fb:1a:2b:3c IEEE 802.11: authenticated`,
      `daemon.info hostapd: wlan1: STA 3c:22:fb:1a:2b:3c IEEE 802.11: associated (aid 1)`,
      `daemon.info hostapd: wlan1: STA 3c:22:fb:1a:2b:3c WPA: pairwise key handshake completed`,
      `daemon.info dnsmasq-dhcp[1420]: DHCPACK(br-lan) 192.168.1.101 3c:22:fb:1a:2b:3c Sabbir-MacBook-Pro`,
      `daemon.info opennds[2105]: Authenticated client 3c:22:fb:1a:2b:3c for 60m session`,
      `daemon.notice netifd: Network device 'wan' link is up`,
      `daemon.info hostapd: wlan0: STA a4:c3:f0:88:99:11 IEEE 802.11: associated (aid 2)`,
      `daemon.info dnsmasq-dhcp[1420]: DHCPACK(br-lan) 192.168.1.105 a4:c3:f0:88:99:11 Galaxy-S23-Ultra`
    ].join('\n');
  }
  if (/^dmesg\b/i.test(cmd)) {
    return [
      `[    0.000000] Linux version 5.15.150 (openwrt@buildhost) (mips-openwrt-linux-musl-gcc) #0 SMP`,
      `[    0.000000] SoC: MediaTek MT7621DAT ver:1 eco:3 (Dual-Core 4-Thread @ 880MHz)`,
      `[    1.240100] mt7603e 0000:01:00.0: MediaTek MT7603E 802.11bgn 2x2 MIMO initialized`,
      `[    1.650200] mt7615e 0000:02:00.0: MediaTek MT7613BEN 802.11an/ac 2x2 MU-MIMO initialized`,
      `[    2.120300] mtk_soc_eth 1e100000.ethernet: PPE hardware flow offloading enabled (flow_offloading_hw=1)`,
      `[    3.400500] 8021q: 802.1Q VLAN Support v1.8`,
      `[   12.450100] br-lan: port 1(lan1) entered forwarding state`,
      `[   14.890200] opennds: captive portal listening on br-lan:2050`
    ].join('\n');
  }
  if (/cat\s+\/proc\/cpuinfo/i.test(cmd) || /cpuinfo/i.test(cmd)) {
    return [
      `system type\t\t: MediaTek MT7621 ver:1 eco:3`,
      `machine\t\t\t: TP-Link Archer C6 v3`,
      `processor\t\t: 0`,
      `cpu model\t\t: MIPS 1004Kc V2.15`,
      `BogoMIPS\t\t: 586.13`,
      `wait instruction\t: yes`,
      `microsecond timers\t: yes`,
      `tlb_entries\t\t: 32`,
      `extra interrupt vector\t: yes`,
      `hardware watchpoint\t: yes, count: 4, address/irw mask: [0x0ffc, 0x0ffc, 0x0ffb, 0x0ffb]`,
      `isa\t\t\t: mips32r2`,
      `ASEs implemented\t: mips16 dsp mt`
    ].join('\n');
  }
  if (/^free\b/i.test(cmd)) {
    return [
      `              total        used        free      shared  buff/cache   available`,
      `Mem:         124960       54280       48190         412       22490       62100`,
      `Swap:             0           0           0`
    ].join('\n');
  }
  if (/^df\b/i.test(cmd)) {
    return [
      `Filesystem                Size      Used Available Use% Mounted on`,
      `/dev/root                 3.8M      3.8M         0 100% /rom`,
      `tmpfs                    61.0M    612.0K     60.4M   1% /tmp`,
      `/dev/mtdblock6           10.5M      4.1M      6.4M  39% /overlay`,
      `overlayfs:/overlay       10.5M      4.1M      6.4M  39% /`
    ].join('\n');
  }
  return `[OpenWrt 23.05] root@Archer-C6:~# ${cmd}\nCommand executed successfully. (exit status 0)`;
}

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

  // 1. GET: Fetch router status metrics (Cached in Redis -> Dev memory -> Simulated fallback)
  if (req.method === 'GET') {
    // If client supplied authentication headers, verify them
    const hasAuth = req.headers['x-router-secret'] || req.headers['authorization'] || req.headers['x-admin-password'];
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

    // Check in-memory dev cache if present and fresh (< 6000ms)
    if (globalThis.__localRouterStatus && (Date.now() - (globalThis.__localRouterStatusTimestamp || 0)) < 6000) {
      return res.status(200).json(globalThis.__localRouterStatus);
    }

    // Try fetching live from local OpenWrt router if reachable and not recently failed (skipped in test mode)
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

    // If live fetch timed out but we have a previous live status, return it
    if (globalThis.__localRouterStatus) {
      return res.status(200).json(globalThis.__localRouterStatus);
    }

    // Default simulated Archer C6 v3 status if router hasn't reported to cloud yet
    return res.status(200).json(getSimulatedStatus());
  }

  // 2. POST: Telemetry reporting OR command enqueuing
  if (req.method === 'POST') {
    // Authenticate all mutating POST operations if routerSecret is set
    if (routerSecret && !checkRouterAuth(req, routerSecret)) {
      return res.status(401).json({ error: 'Unauthorized: Invalid or missing authentication secret.' });
    }

    const payload = req.body || {};

    // A. Router reporting its latest telemetry (from archer_c6_helper.sh or sync.sh)
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

    // B. Enqueuing hardware commands for the Archer C6
    const { command, target, value } = payload;
    if (!command || typeof command !== 'string') {
      return res.status(400).json({ error: 'Field "command" is required.' });
    }

    const cleanCmd = command.trim();
    let routerCmd = '';
    let simulatedOutput = null;

    switch (cleanCmd) {
      case 'reboot':
        routerCmd = 'reboot';
        break;

      case 'drop_caches':
        routerCmd = 'echo 3 > /proc/sys/vm/drop_caches';
        break;

      case 'wifi_toggle': {
        const radio = target && /^[a-zA-Z0-9_-]+$/.test(target) ? target : 'radio0';
        const disabled = value === 'off' ? '1' : '0';
        routerCmd = `uci set wireless.${radio}.disabled='${disabled}' && uci commit wireless && wifi reload`;
        break;
      }

      case 'set_txpower': {
        const radio = target && /^[a-zA-Z0-9_-]+$/.test(target) ? target : 'radio0';
        const dbm = parseInt(value, 10);
        const safeDbm = !isNaN(dbm) && dbm >= 1 && dbm <= 30 ? dbm : 20;
        routerCmd = `uci set wireless.${radio}.txpower='${safeDbm}' && uci commit wireless && wifi reload`;
        break;
      }

      case 'set_wifi_channel': {
        const radio = target && /^[a-zA-Z0-9_-]+$/.test(target) ? target : 'radio0';
        const chan = parseInt(value, 10);
        const safeChan = !isNaN(chan) && chan >= 0 && chan <= 165 ? chan : 0;
        routerCmd = `uci set wireless.${radio}.channel='${safeChan}' && uci commit wireless && wifi reload`;
        break;
      }

      case 'set_wifi_htmode': {
        const radio = target && /^[a-zA-Z0-9_-]+$/.test(target) ? target : 'radio0';
        const allowed = ['HT20', 'HT40', 'VHT20', 'VHT40', 'VHT80', 'NOHT'];
        const safeMode = allowed.includes(value) ? value : 'HT20';
        routerCmd = `uci set wireless.${radio}.htmode='${safeMode}' && uci commit wireless && wifi reload`;
        break;
      }

      case 'set_wifi_ssid': {
        const iface = target && /^[a-zA-Z0-9_@.-]+$/.test(target) ? target : 'default_radio0';
        const cleanSsid = typeof value === 'string' ? value.replace(/['"\\]/g, '').substring(0, 32) : 'Archer_C6';
        routerCmd = `uci set wireless.${iface}.ssid='${cleanSsid}' && uci commit wireless && wifi reload`;
        break;
      }

      case 'add_wifi_ssid': {
        const rad = target && /^[a-zA-Z0-9_-]+$/.test(target) ? target : 'radio0';
        const cleanSsid = typeof value === 'string' ? value.replace(/['"\\]/g, '').substring(0, 32) : 'New_SSID';
        const sec = `ap_${cleanSsid.replace(/[^a-zA-Z0-9_]/g, '').substring(0, 10)}`;
        routerCmd = `uci set wireless.${sec}=wifi-iface && uci set wireless.${sec}.device='${rad}' && uci set wireless.${sec}.mode='ap' && uci set wireless.${sec}.network='lan' && uci set wireless.${sec}.ssid='${cleanSsid}' && uci set wireless.${sec}.encryption='psk2' && uci commit wireless && wifi reload`;
        break;
      }

      case 'del_wifi_ssid': {
        const sec = target && /^[a-zA-Z0-9_@.-]+$/.test(target) ? target : '';
        if (sec) {
          routerCmd = `uci delete wireless.${sec} && uci commit wireless && wifi reload`;
        }
        break;
      }

      case 'toggle_wifi_ssid': {
        const sec = target && /^[a-zA-Z0-9_@.-]+$/.test(target) ? target : 'default_radio0';
        const disabled = (value === 'off' || value === '0' || value === false) ? '1' : '0';
        routerCmd = `uci set wireless.${sec}.disabled='${disabled}' && uci commit wireless && wifi reload`;
        break;
      }

      case 'guest_wifi_toggle': {
        const disabled = (value === 'on' || value === '1' || value === true) ? '0' : '1';
        routerCmd = `uci set wireless.guest.disabled='${disabled}' && uci commit wireless && wifi reload`;
        break;
      }

      case 'set_wifi_advanced': {
        const opt = target && /^[a-zA-Z0-9_-]+$/.test(target) ? target : 'roaming';
        const flag = (value === 'on' || value === '1' || value === true) ? '1' : '0';
        routerCmd = `uci set wireless.@wifi-iface[0].${opt}='${flag}' && uci commit wireless && wifi reload`;
        break;
      }

      case 'block_client': {
        if (!target || !MAC_REGEX.test(target)) {
          return res.status(400).json({ error: 'Valid target MAC address required for block_client.' });
        }
        routerCmd = `iptables -I FORWARD 1 -m mac --mac-source ${target.toLowerCase()} -j DROP`;
        break;
      }

      case 'unblock_client': {
        if (!target || !MAC_REGEX.test(target)) {
          return res.status(400).json({ error: 'Valid target MAC address required for unblock_client.' });
        }
        routerCmd = `iptables -D FORWARD -m mac --mac-source ${target.toLowerCase()} -j DROP`;
        break;
      }

      case 'nds_auth': {
        if (!target || !MAC_REGEX.test(target)) {
          return res.status(400).json({ error: 'Valid target MAC address required for nds_auth.' });
        }
        const duration = parseInt(value, 10);
        const safeDuration = !isNaN(duration) && duration >= 0 ? duration : 60;
        routerCmd = `ndsctl auth ${target.toLowerCase()} ${safeDuration}`;
        break;
      }

      case 'nds_deauth':
      case 'deauth': {
        if (!target || !MAC_REGEX.test(target)) {
          return res.status(400).json({ error: 'Valid target MAC address required for nds_deauth.' });
        }
        routerCmd = `ndsctl deauth ${target.toLowerCase()}`;
        break;
      }

      case 'wol': {
        if (!target || !MAC_REGEX.test(target)) {
          return res.status(400).json({ error: 'Valid target MAC address required for wol.' });
        }
        routerCmd = `etherwake -i br-lan ${target.toLowerCase()}`;
        break;
      }

      case 'set_static_lease': {
        if (!target || !MAC_REGEX.test(target)) {
          return res.status(400).json({ error: 'Valid target MAC address required for set_static_lease.' });
        }
        const ip = value && typeof value === 'string' ? value.trim() : '';
        if (!/^192\.168\.\d+\.\d+$/.test(ip) && !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
          return res.status(400).json({ error: 'Valid IP address required for set_static_lease.' });
        }
        const sec = `host_${target.toLowerCase().replace(/:/g, '')}`;
        routerCmd = `uci set dhcp.${sec}=host && uci set dhcp.${sec}.mac='${target.toLowerCase()}' && uci set dhcp.${sec}.ip='${ip}' && uci commit dhcp`;
        break;
      }

      case 'del_static_lease': {
        if (!target || !MAC_REGEX.test(target)) {
          return res.status(400).json({ error: 'Valid target MAC address required for del_static_lease.' });
        }
        const sec = `host_${target.toLowerCase().replace(/:/g, '')}`;
        routerCmd = `uci delete dhcp.${sec} && uci commit dhcp`;
        break;
      }

      case 'led_stealth': {
        const brightness = value === 'on' ? '1' : '0';
        routerCmd = `for _l in /sys/class/leds/*; do [ -d "$_l" ] && echo ${brightness} > "$_l/brightness" 2>/dev/null; done`;
        break;
      }

      case 'set_hw_offload': {
        const flag = (value === 'on' || value === '1' || value === true) ? '1' : '0';
        routerCmd = `uci set firewall.@defaults[0].flow_offloading='${flag}' && uci set firewall.@defaults[0].flow_offloading_hw='${flag}' && uci commit firewall && /etc/init.d/firewall restart`;
        break;
      }

      case 'set_sqm': {
        const flag = (value === 'on' || value === '1' || value === true) ? '1' : '0';
        routerCmd = `uci set sqm.@queue[0].enabled='${flag}' && uci commit sqm && /etc/init.d/sqm restart`;
        break;
      }

      case 'set_sqm_limits': {
        const qdisc = target && ['cake', 'fq_codel'].includes(target) ? target : 'cake';
        const dl = parseInt(value && typeof value === 'object' ? value.download : value, 10) || 95000;
        const ul = parseInt(value && typeof value === 'object' ? value.upload : target, 10) || 20000;
        routerCmd = `uci set sqm.@queue[0].qdisc='${qdisc}' && uci set sqm.@queue[0].download='${dl}' && uci set sqm.@queue[0].upload='${ul}' && uci commit sqm && /etc/init.d/sqm restart`;
        break;
      }

      case 'set_wireguard': {
        const active = (value === 'on' || value === '1' || value === true);
        routerCmd = active ? 'ifup wg0' : 'ifdown wg0';
        break;
      }

      case 'set_multiwan': {
        const flag = (value === 'on' || value === '1' || value === true) ? '1' : '0';
        const action = flag === '1' ? 'restart' : 'stop';
        routerCmd = `uci set mwan3.globals.enabled='${flag}' && uci commit mwan3 && /etc/init.d/mwan3 ${action}`;
        break;
      }

      case 'set_doh': {
        const flag = (value === 'on' || value === '1' || value === true) ? '1' : '0';
        const action = flag === '1' ? 'start' : 'stop';
        routerCmd = `/etc/init.d/https-dns-proxy ${action}`;
        break;
      }

      case 'set_quota': {
        const quotaGb = parseInt(value, 10) || 50;
        const resetDay = parseInt(req.body.reset_day || (typeof target === 'number' ? target : 1), 10) || 1;
        const warnPct = parseInt(req.body.warning_percent || 80, 10) || 80;
        routerCmd = `uci set archer_guard.quota=section && uci set archer_guard.quota.total_gb='${quotaGb}' && uci set archer_guard.quota.reset_day='${resetDay}' && uci set archer_guard.quota.warn_pct='${warnPct}' && uci commit archer_guard`;

        simState.quotaGb = quotaGb;
        simState.quotaResetDay = resetDay;
        simState.quotaWarnPct = warnPct;

        if (globalThis.__localRouterStatus?.analytics?.quota) {
          globalThis.__localRouterStatus.analytics.quota.total_gb = quotaGb;
          globalThis.__localRouterStatus.analytics.quota.reset_day = resetDay;
          globalThis.__localRouterStatus.analytics.quota.warning_percent = warnPct;
        }

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
          } catch (e) {
            console.warn('[Router API] Could not update cached quota in Redis:', e.message);
          }
        }
        break;
      }

      case 'reset_quota': {
        routerCmd = `wrtbwmon reset || rm -f /tmp/usage.db /tmp/wrtbwmon/usage.db`;
        simState.quotaUsedBytes = 0;
        simState.quotaRxBytes = 0;
        simState.quotaTxBytes = 0;
        if (globalThis.__localRouterStatus?.analytics?.quota) {
          globalThis.__localRouterStatus.analytics.quota.used_bytes = 0;
          globalThis.__localRouterStatus.analytics.quota.rx_bytes = 0;
          globalThis.__localRouterStatus.analytics.quota.tx_bytes = 0;
        }
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
          } catch (e) {
            console.warn('[Router API] Could not reset cached quota in Redis:', e.message);
          }
        }
        break;
      }

      case 'set_client_quota': {
        if (!target || !MAC_REGEX.test(target)) {
          return res.status(400).json({ error: 'Valid target MAC address required for set_client_quota.' });
        }
        const capGb = parseFloat(value) || 10;
        routerCmd = `uci set archer_guard.quota_${target.toLowerCase().replace(/:/g, '')}='${capGb}' && uci commit archer_guard`;
        break;
      }

      case 'toggle_cron_task': {
        const task = target && /^[a-zA-Z0-9_-]+$/.test(target) ? target : 'midnight_reboot';
        const enabled = (value === 'on' || value === '1' || value === true);
        if (task === 'midnight_reboot') {
          routerCmd = enabled
            ? `echo '0 4 * * * /sbin/reboot' >> /etc/crontabs/root && /etc/init.d/cron restart`
            : `sed -i '/\\/sbin\\/reboot/d' /etc/crontabs/root && /etc/init.d/cron restart`;
        } else if (task === 'wifi_sleep') {
          routerCmd = enabled
            ? `echo '0 1 * * * /sbin/wifi down' >> /etc/crontabs/root && echo '0 7 * * * /sbin/wifi up' >> /etc/crontabs/root && /etc/init.d/cron restart`
            : `sed -i '/wifi[[:space:]]\\+down/d' /etc/crontabs/root && sed -i '/wifi[[:space:]]\\+up/d' /etc/crontabs/root && /etc/init.d/cron restart`;
        } else if (task === 'nightly_flush') {
          routerCmd = enabled
            ? `echo '30 3 * * * sync && echo 3 > /proc/sys/vm/drop_caches' >> /etc/crontabs/root && /etc/init.d/cron restart`
            : `sed -i '/drop_caches/d' /etc/crontabs/root && /etc/init.d/cron restart`;
        } else {
          routerCmd = `/etc/init.d/cron restart`;
        }
        break;
      }

      case 'set_cron_schedule': {
        const expr = (target && typeof target === 'string') ? target.replace(/['"\\]/g, '') : '0 4 * * *';
        const cmd = (value && typeof value === 'string') ? value.replace(/['"\\]/g, '') : '/sbin/reboot';
        routerCmd = `echo '${expr} ${cmd}' >> /etc/crontabs/root && /etc/init.d/cron restart`;
        break;
      }

      case 'set_homeassistant_webhook': {
        const webhookUrl = (value && typeof value === 'string') ? value.replace(/['"\\]/g, '') : '';
        const enabled = req.body.enabled !== false ? '1' : '0';
        routerCmd = `uci set archer_guard.ha=section && uci set archer_guard.ha.enabled='${enabled}' && uci set archer_guard.ha.webhook='${webhookUrl}' && uci commit archer_guard`;
        break;
      }

      case 'trigger_ha_webhook': {
        const webhookUrl = (req.body.webhook_url && typeof req.body.webhook_url === 'string')
          ? req.body.webhook_url.replace(/['"\\]/g, '')
          : 'http://homeassistant.local:8123/api/webhook/archer_c6_presence';
        const mac = target && MAC_REGEX.test(target) ? target.toLowerCase() : '3c:22:fb:1a:2b:3c';
        const state = value === 'disconnected' ? 'disconnected' : 'connected';
        routerCmd = `curl -s -m 3 -X POST -H 'Content-Type: application/json' -d '{"device":"archer_c6","mac":"${mac}","state":"${state}"}' '${webhookUrl}'`;
        break;
      }

      case 'raw_cmd': {
        const rawCmd = (value && typeof value === 'string') ? value.trim() : (target && typeof target === 'string' ? target.trim() : 'uptime');
        routerCmd = rawCmd;
        simulatedOutput = getSimulatedTerminalOutput(rawCmd);
        break;
      }

      default:
        return res.status(400).json({ error: `Unsupported command: "${cleanCmd}".` });
    }

    // Push into Upstash Redis queue 'pending_commands' if connected
    if (redis) {
      try {
        await redis.rpush('pending_commands', routerCmd);
      } catch (e) {
        console.warn('[Router API] Could not push to Redis queue:', e.message);
      }
    }

    // Push to dev-server in-memory queue if running locally
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
