#!/bin/sh
# ==============================================================================
# ArcherGuard C6 — Automated WireGuard VPN Server Setup & Client Generator
# Target: OpenWrt 23.05+ (MediaTek MT7621 / Archer C6 v3/v4)
# Max Lines: <= 250 (DRY Principle Enforced)
# ==============================================================================

set -e

WG_DIR="/etc/wireguard"
WG_IFACE="wg0"
WG_PORT="${2:-51820}"
WG_NET="10.14.0.0/24"
SERVER_IP="10.14.0.1"
CLIENT_IP="10.14.0.2"

# Detect Public IP / DDNS for endpoint
get_public_endpoint() {
    if [ -n "$1" ]; then
        echo "$1"
        return
    fi
    _ext_ip=""
    if command -v uclient-fetch >/dev/null 2>&1; then
        _ext_ip=$(uclient-fetch -q --timeout=3 -O - https://api.ipify.org 2>/dev/null || true)
    elif command -v curl >/dev/null 2>&1; then
        _ext_ip=$(curl -s -m 3 https://api.ipify.org 2>/dev/null || true)
    elif command -v wget >/dev/null 2>&1; then
        _ext_ip=$(wget -q -T 3 -O - https://api.ipify.org 2>/dev/null || true)
    fi
    if [ -z "$_ext_ip" ]; then
        # Try getting WAN IP from uci network
        _ext_ip=$(uci -q get network.wan.ipaddr 2>/dev/null || true)
    fi
    echo "${_ext_ip:-YOUR_ROUTER_PUBLIC_IP_OR_DDNS}"
}

ENDPOINT_HOST=$(get_public_endpoint "$1")

printf "\n⚡ [ArcherGuard C6] Setting up WireGuard VPN Remote Control Server...\n\n"

# 1. Package Verification
printf "📦 Checking WireGuard kernel & utility packages...\n"
if ! command -v wg >/dev/null 2>&1; then
    printf "   Installing kmod-wireguard, wireguard-tools, and qrencode via opkg...\n"
    opkg update || true
    opkg install kmod-wireguard wireguard-tools qrencode || {
        printf "❌ Failed to install WireGuard packages. Check internet connection.\n"
        exit 1
    }
fi

umask 077
mkdir -p "$WG_DIR"
chmod 700 "$WG_DIR"

# 2. Key Generation
printf "🔑 Generating Cryptographic Keypairs (Curve25519)...\n"
if [ ! -f "$WG_DIR/server.key" ]; then
    wg genkey > "$WG_DIR/server.key"
    chmod 600 "$WG_DIR/server.key"
    wg pubkey < "$WG_DIR/server.key" > "$WG_DIR/server.pub"
fi
SERVER_PRIVKEY=$(cat "$WG_DIR/server.key")
SERVER_PUBKEY=$(cat "$WG_DIR/server.pub")

if [ ! -f "$WG_DIR/client.key" ]; then
    wg genkey > "$WG_DIR/client.key"
    chmod 600 "$WG_DIR/client.key"
    wg pubkey < "$WG_DIR/client.key" > "$WG_DIR/client.pub"
fi
CLIENT_PRIVKEY=$(cat "$WG_DIR/client.key")
CLIENT_PUBKEY=$(cat "$WG_DIR/client.pub")

# 3. UCI Network Interface Configuration
printf "🌐 Configuring Network Interface 'wg0' (IP: %s/24, Port: %s)...\n" "$SERVER_IP" "$WG_PORT"

uci -q delete network."$WG_IFACE" || true
uci -q delete network.wg_client || true

uci set network."$WG_IFACE"=interface
uci set network."$WG_IFACE".proto='wireguard'
uci set network."$WG_IFACE".private_key="$SERVER_PRIVKEY"
uci set network."$WG_IFACE".listen_port="$WG_PORT"
uci add_list network."$WG_IFACE".addresses="$SERVER_IP/24"

# Client Peer
uci set network.wg_client=wireguard_"$WG_IFACE"
uci set network.wg_client.public_key="$CLIENT_PUBKEY"
uci set network.wg_client.description="ArcherGuard Android Client"
uci add_list network.wg_client.allowed_ips="$CLIENT_IP/32"
uci set network.wg_client.route_allowed_ips='1'
uci set network.wg_client.persistent_keepalive='25'

uci commit network

# 4. UCI Firewall Configuration & Dedicated VPN Zone Isolation
printf "🛡️ Configuring Firewall rules & dedicated VPN zone isolation...\n"

# Delete any existing WireGuard rule to prevent duplicates
while uci -q delete firewall.allow_wireguard 2>/dev/null; do :; done

# Remove wg0 from trusted LAN zone
uci -q del_list firewall.@zone[0].network="$WG_IFACE" 2>/dev/null || true

# Create dedicated 'vpn' firewall zone (Neutralizes VULN-WG-01)
uci -q delete firewall.vpn_zone 2>/dev/null || true
uci set firewall.vpn_zone=zone
uci set firewall.vpn_zone.name='vpn'
uci set firewall.vpn_zone.network="$WG_IFACE"
uci set firewall.vpn_zone.input='REJECT'
uci set firewall.vpn_zone.output='ACCEPT'
uci set firewall.vpn_zone.forward='REJECT'

# Allow WireGuard clients to access router DNS and administrative Web/API (HTTP & HTTPS)
uci -q delete firewall.allow_vpn_api 2>/dev/null || true
uci set firewall.allow_vpn_api=rule
uci set firewall.allow_vpn_api.name='Allow-VPN-API'
uci set firewall.allow_vpn_api.src='vpn'
uci set firewall.allow_vpn_api.dest_port='53 80 443'
uci set firewall.allow_vpn_api.proto='tcp udp'
uci set firewall.allow_vpn_api.target='ACCEPT'

# Allow VPN forwarding strictly to WAN (Internet access only, no LAN peering)
uci -q delete firewall.vpn_to_wan 2>/dev/null || true
uci set firewall.vpn_to_wan=forwarding
uci set firewall.vpn_to_wan.src='vpn'
uci set firewall.vpn_to_wan.dest='wan'

# Apply WAN rate-limiting to WireGuard port 51820 UDP (Neutralizes VULN-FW-04)
uci -q delete firewall.wg_wan_rate 2>/dev/null || true
uci set firewall.wg_wan_rate=rule
uci set firewall.wg_wan_rate.name='Rate-Limit-WireGuard'
uci set firewall.wg_wan_rate.src='wan'
uci set firewall.wg_wan_rate.dest_port="$WG_PORT"
uci set firewall.wg_wan_rate.proto='udp'
uci set firewall.wg_wan_rate.limit='10/sec'
uci set firewall.wg_wan_rate.target='ACCEPT'

uci commit firewall

# 5. Generate Client Profile (.conf)
CLIENT_CONF="$WG_DIR/archer_c6_client.conf"
cat <<EOF > "$CLIENT_CONF"
[Interface]
# ArcherGuard C6 Android Client Tunnel
PrivateKey = $CLIENT_PRIVKEY
Address = $CLIENT_IP/24
DNS = $SERVER_IP

[Peer]
# ArcherGuard C6 Router Peer
PublicKey = $SERVER_PUBKEY
Endpoint = $ENDPOINT_HOST:$WG_PORT
AllowedIPs = 10.14.0.0/24, 192.168.1.0/24
PersistentKeepalive = 25
EOF
chmod 600 "$CLIENT_CONF"

# 6. Apply Changes (Non-Disruptive Zero-Downtime Reload)
printf "🔄 Reloading WireGuard interface & firewall subsystems (Zero Downtime)...\n"
ubus call network.interface.wg0 reload 2>/dev/null || ifup wg0 2>/dev/null || true
/etc/init.d/firewall reload >/dev/null 2>&1 || true

# 7. Display Results & QR Code
printf "\n=======================================================\n"
printf "🎉 WireGuard VPN Server Successfully Configured!\n"
printf "=======================================================\n"
printf "Router Interface:  %s (%s/24)\n" "$WG_IFACE" "$SERVER_IP"
printf "Public Endpoint:   %s:%s\n" "$ENDPOINT_HOST" "$WG_PORT"
printf "Client Address:    %s/24\n" "$CLIENT_IP"
printf "Configuration:     %s\n\n" "$CLIENT_CONF"

printf "📄 Client Profile (Permissions: 600):\n"
printf -- "-------------------------------------------------------\n"
printf "Saved securely to %s\n" "$CLIENT_CONF"
printf -- "-------------------------------------------------------\n\n"

if command -v qrencode >/dev/null 2>&1; then
    printf "📱 Scan this QR Code with your WireGuard Android App:\n\n"
    qrencode -t ansiutf8 < "$CLIENT_CONF"
    printf "\n"
else
    printf "💡 Tip: Install 'qrencode' to scan profiles directly on terminal:\n"
    printf "   opkg update && opkg install qrencode\n\n"
fi

printf "🚀 You can now connect your Android App to: http://%s/cgi-bin/api\n\n" "$SERVER_IP"
