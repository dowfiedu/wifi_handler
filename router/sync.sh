#!/bin/sh
# ==============================================================================
# OpenWrt openNDS Sync Daemon (router/sync.sh)
#
# Periodically polls Vercel /api/poll or /api/pending-auth for commands.
# Max lines: < 250 (DRY Principle Enforced)
# ==============================================================================

[ -f /etc/opennds/sync.conf ] && . /etc/opennds/sync.conf
[ -f ./sync.conf ] && . ./sync.conf

API_URL="${API_URL:-https://your-deployment.vercel.app/api/poll}"
ROUTER_SECRET_KEY="${ROUTER_SECRET_KEY:-change_this_secret_key}"
POLL_INTERVAL="${POLL_INTERVAL:-5}"
LOG_TAG="${LOG_TAG:-opennds-sync}"

log() {
    _level="$1"; _msg="$2"
    printf "[%s] [%s] %s\n" "$(date '+%Y-%m-%d %H:%M:%S')" "$_level" "$_msg"
    command -v logger >/dev/null 2>&1 && logger -t "$LOG_TAG" "[$_level] $_msg"
}

# Dependency checks
if ! command -v uclient-fetch >/dev/null 2>&1 && ! command -v curl >/dev/null 2>&1; then
    log "ERROR" "'uclient-fetch' or 'curl' required for HTTP communication."
    exit 1
fi
! command -v ndsctl >/dev/null 2>&1 && log "WARN" "'ndsctl' not in PATH. Dry-run mode active."

get_connected_macs() {
    _macs=""
    if command -v iw >/dev/null 2>&1; then
        for _dev in $(iw dev 2>/dev/null | awk '$1=="Interface"{print $2}'); do
            _dev_macs=$(iw dev "$_dev" station dump 2>/dev/null | awk '$1=="Station"{printf "%s,", tolower($2)}')
            _macs="${_macs}${_dev_macs}"
        done
        printf '%s' "$_macs" | sed 's/,$//'
    fi
}

http_get() {
    _url="$1"; _macs="$2"
    if command -v uclient-fetch >/dev/null 2>&1; then
        uclient-fetch -q --timeout=10 --header="x-router-secret: $ROUTER_SECRET_KEY" --header="x-router-connected-macs: $_macs" --header="Accept: application/json, text/plain" -O - "$_url" 2>/dev/null
    elif command -v curl >/dev/null 2>&1; then
        curl -s -f -m 10 -H "x-router-secret: $ROUTER_SECRET_KEY" -H "x-router-connected-macs: $_macs" -H "Accept: application/json, text/plain" "$_url" 2>/dev/null
    fi
}

http_post() {
    _url="$1"; _data="$2"; _content_type="${3:-application/x-www-form-urlencoded}"
    if command -v uclient-fetch >/dev/null 2>&1; then
        uclient-fetch -q --timeout=5 --header="x-router-secret: $ROUTER_SECRET_KEY" --header="Content-Type: $_content_type" --post-data="$_data" -O - "$_url" >/dev/null 2>&1
    elif command -v curl >/dev/null 2>&1; then
        curl -s -m 5 -X POST -H "x-router-secret: $ROUTER_SECRET_KEY" -H "Content-Type: $_content_type" -d "$_data" "$_url" >/dev/null 2>&1
    fi
}

# Unified regex parser for command and MAC
parse_json_field() {
    _raw="$1"; _field="$2"
    if command -v jsonfilter >/dev/null 2>&1; then
        printf '%s' "$_raw" | jsonfilter -e "@.$_field"
    elif command -v jq >/dev/null 2>&1; then
        printf '%s' "$_raw" | jq -r ".$_field // empty"
    else
        printf '%s' "$_raw" | sed -n "s/.*\"$_field\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p"
    fi
}

parse_command() {
    parse_json_field "$1" "command"
}

parse_mac() {
    _raw="$1"
    case "$_raw" in
        [0-9a-fA-F][0-9a-fA-F]:[0-9a-fA-F][0-9a-fA-F]:[0-9a-fA-F][0-9a-fA-F]:[0-9a-fA-F][0-9a-fA-F]:[0-9a-fA-F][0-9a-fA-F]:[0-9a-fA-F][0-9a-fA-F])
            printf '%s' "$_raw"; return 0 ;;
    esac
    parse_json_field "$_raw" "mac"
}

is_command_safe() {
    # ANTI-BRICK: strictly block dangerous flashing, disk wipe, or LAN lockout commands
    case "$1" in
        *mtd*|*flash_*|*fw_setenv*|*dd\ *|*mkfs*|*fdisk*|*parted*|*rm\ -rf*|*network.lan*|*ifdown\ lan*|*br-lan\ down*|*dhcp.lan.ignore*|*passwd*|*shadow*|*inittab*|*\:\(\)\{*) return 1 ;;
        *sysupgrade*)
            case "$1" in
                sysupgrade\ -b\ *) ;;
                *) return 1 ;;
            esac ;;
    esac
    case "$1" in
        ndsctl\ auth\ [0-9a-fA-F][0-9a-fA-F]:[0-9a-fA-F][0-9a-fA-F]:[0-9a-fA-F][0-9a-fA-F]:[0-9a-fA-F][0-9a-fA-F]:[0-9a-fA-F][0-9a-fA-F]:[0-9a-fA-F][0-9a-fA-F]\ [0-9]*) return 0 ;;
        ndsctl\ deauth\ [0-9a-fA-F][0-9a-fA-F]:[0-9a-fA-F][0-9a-fA-F]:[0-9a-fA-F][0-9a-fA-F]:[0-9a-fA-F][0-9a-fA-F]:[0-9a-fA-F][0-9a-fA-F]:[0-9a-fA-F][0-9a-fA-F]) return 0 ;;
        ndsctl\ trust\ [0-9a-fA-F][0-9a-fA-F]:[0-9a-fA-F][0-9a-fA-F]:[0-9a-fA-F][0-9a-fA-F]:[0-9a-fA-F][0-9a-fA-F]:[0-9a-fA-F][0-9a-fA-F]:[0-9a-fA-F][0-9a-fA-F]) return 0 ;;
        ndsctl\ untrust\ [0-9a-fA-F][0-9a-fA-F]:[0-9a-fA-F][0-9a-fA-F]:[0-9a-fA-F][0-9a-fA-F]:[0-9a-fA-F][0-9a-fA-F]:[0-9a-fA-F][0-9a-fA-F]:[0-9a-fA-F][0-9a-fA-F]) return 0 ;;
        "reboot") return 0 ;;
        "echo 3 > /proc/sys/vm/drop_caches") return 0 ;;
        uci\ set\ wireless.*.disabled=\'[01]\'\ \&\&\ uci\ commit\ wireless\ \&\&\ wifi\ reload) return 0 ;;
        uci\ set\ wireless.*.txpower=\'[0-9]*\'\ \&\&\ uci\ commit\ wireless\ \&\&\ wifi\ reload) return 0 ;;
        uci\ set\ wireless.*.channel=\'[0-9]*\'\ \&\&\ uci\ commit\ wireless\ \&\&\ wifi\ reload) return 0 ;;
        uci\ set\ wireless.*.htmode=\'*\'\ \&\&\ uci\ commit\ wireless\ \&\&\ wifi\ reload) return 0 ;;
        uci\ set\ wireless.*.ssid=\'*\'\ \&\&\ uci\ commit\ wireless\ \&\&\ wifi\ reload) return 0 ;;
        uci\ set\ wireless.*) return 0 ;;
        uci\ delete\ wireless.*) return 0 ;;
        iptables\ -I\ FORWARD\ 1\ -m\ mac\ --mac-source\ [0-9a-fA-F][0-9a-fA-F]:[0-9a-fA-F][0-9a-fA-F]:[0-9a-fA-F][0-9a-fA-F]:[0-9a-fA-F][0-9a-fA-F]:[0-9a-fA-F][0-9a-fA-F]:[0-9a-fA-F][0-9a-fA-F]\ -j\ DROP) return 0 ;;
        iptables\ -D\ FORWARD\ -m\ mac\ --mac-source\ [0-9a-fA-F][0-9a-fA-F]:[0-9a-fA-F][0-9a-fA-F]:[0-9a-fA-F][0-9a-fA-F]:[0-9a-fA-F][0-9a-fA-F]:[0-9a-fA-F][0-9a-fA-F]:[0-9a-fA-F][0-9a-fA-F]\ -j\ DROP) return 0 ;;
        etherwake\ -i\ br-lan\ [0-9a-fA-F][0-9a-fA-F]:[0-9a-fA-F][0-9a-fA-F]:[0-9a-fA-F][0-9a-fA-F]:[0-9a-fA-F][0-9a-fA-F]:[0-9a-fA-F][0-9a-fA-F]:[0-9a-fA-F][0-9a-fA-F]) return 0 ;;
        uci\ set\ dhcp.*) return 0 ;;
        uci\ delete\ dhcp.*) return 0 ;;
        "for _l in /sys/class/leds/"*) return 0 ;;
        uci\ set\ firewall.@defaults\[0\].flow_offloading*) return 0 ;;
        /etc/init.d/firewall\ restart) return 0 ;;
        uci\ set\ sqm.@queue\[0\].*) return 0 ;;
        /etc/init.d/sqm\ restart) return 0 ;;
        ifup\ wg0|ifdown\ wg0) return 0 ;;
        uci\ set\ mwan3.*) return 0 ;;
        /etc/init.d/mwan3\ *) return 0 ;;
        /etc/init.d/https-dns-proxy\ *) return 0 ;;
        *network.wan*peerdns*|*network.wan*dns*|*/etc/init.d/network\ reload*) return 0 ;;
        sysupgrade\ -b\ *|tar\ -czf\ /tmp/backup-OpenWrt-c6.tar.gz*) return 0 ;;
        uci\ set\ archer_guard.*) return 0 ;;
        uci\ commit\ archer_guard*) return 0 ;;
        wrtbwmon\ *) return 0 ;;
        *crontabs/root*|/etc/init.d/cron\ restart) return 0 ;;
        *) return 1 ;;
    esac
}

kick_wifi_client() {
    _mac="$1"
    [ -z "$_mac" ] && return 0
    if command -v ubus >/dev/null 2>&1; then
        for _h in $(ubus list 'hostapd.*' 2>/dev/null); do
            ubus call "$_h" del_client "{\"addr\":\"$_mac\",\"reason\":1,\"deauth\":true}" >/dev/null 2>&1
        done
    fi
    if command -v iw >/dev/null 2>&1; then
        for _dev in $(iw dev 2>/dev/null | awk '$1=="Interface"{print $2}'); do
            iw dev "$_dev" station del "$_mac" >/dev/null 2>&1
        done
    fi
}

confirm_action() {
    _cmd="$1"; _mac="$2"; _status="${3:-success}"; _details="$4"
    _url="${CONFIRM_URL:-$(printf '%s' "$API_URL" | sed 's/\(poll\|pending-auth\)/confirm-auth/')}"
    http_post "$_url" "mac=$_mac&command=$(printf '%s' "$_cmd" | tr ' ' '+')&status=$_status&details=$(printf '%s' "$_details" | tr ' ' '+')" "application/x-www-form-urlencoded"
    log "INFO" "Confirmed action: '$_cmd' [status: $_status]"
}

confirm_auth() {
    _mac="$1"
    confirm_action "ndsctl auth $_mac" "$_mac" "success" "Authenticated"
}

trap 'log "INFO" "Stopping sync daemon."; exit 0' INT TERM

log "INFO" "Starting openNDS sync service on $API_URL (Interval: ${POLL_INTERVAL}s)"

while true; do
    _connected_macs=$(get_connected_macs)
    resp=$(http_get "$API_URL" "$_connected_macs")
    _err=$?

    if [ $_err -ne 0 ]; then
        log "WARN" "Poll failed (code $_err)."
    elif [ -n "$resp" ]; then
        cmd=$(parse_command "$resp")
        if [ -n "$cmd" ] && [ "$cmd" != "null" ]; then
            if is_command_safe "$cmd"; then
                case "$cmd" in
                    ndsctl\ *)
                        if command -v ndsctl >/dev/null 2>&1; then
                            out=$($cmd 2>&1); log "INFO" "Executed: '$cmd' [$out]"
                        else
                            log "INFO" "[DRY-RUN] Simulating: $cmd"
                        fi
                        ;;
                    reboot)
                        log "WARN" "Executing router reboot in 1 second..."
                        confirm_action "$cmd" "" "success" "Rebooting"
                        ( sleep 1; reboot ) >/dev/null 2>&1 &
                        ;;
                    *)
                        out=$(eval "$cmd" 2>&1); log "INFO" "Executed: '$cmd' [$out]"
                        ;;
                esac

                case "$cmd" in
                    ndsctl\ deauth\ *)
                        _deauth_mac=$(printf '%s' "$cmd" | awk '{print $3}')
                        kick_wifi_client "$_deauth_mac"
                        if command -v uci >/dev/null 2>&1; then
                            uci del_list opennds.@opennds[0].trustedmac="$_deauth_mac" >/dev/null 2>&1
                            uci commit opennds >/dev/null 2>&1
                        fi
                        confirm_action "$cmd" "$_deauth_mac" "success" "Deauthenticated"
                        ;;
                    ndsctl\ trust\ *)
                        _trust_mac=$(printf '%s' "$cmd" | awk '{print $3}')
                        if command -v uci >/dev/null 2>&1; then
                            uci add_list opennds.@opennds[0].trustedmac="$_trust_mac" >/dev/null 2>&1
                            uci commit opennds >/dev/null 2>&1
                        fi
                        confirm_action "$cmd" "$_trust_mac" "success" "Permanent Trusted"
                        ;;
                    ndsctl\ untrust\ *)
                        _untrust_mac=$(printf '%s' "$cmd" | awk '{print $3}')
                        if command -v uci >/dev/null 2>&1; then
                            uci del_list opennds.@opennds[0].trustedmac="$_untrust_mac" >/dev/null 2>&1
                            uci commit opennds >/dev/null 2>&1
                        fi
                        confirm_action "$cmd" "$_untrust_mac" "success" "Untrusted"
                        ;;
                    ndsctl\ auth\ *)
                        confirm_action "$cmd" "$(printf '%s' "$cmd" | awk '{print $3}')" "success" "Authenticated"
                        ;;
                    reboot)
                        ;;
                    *)
                        confirm_action "$cmd" "" "success" "$out"
                        ;;
                esac
            else
                log "ERROR" "SECURITY ALERT: Rejected command: '$cmd'"
            fi
        else
            mac=$(parse_mac "$resp")
            if [ -n "$mac" ] && [ "$mac" != "null" ]; then
                log "INFO" "Authorizing pending client: $mac"
                command -v ndsctl >/dev/null 2>&1 && ndsctl auth "$mac" "${DEFAULT_AUTH_DURATION:-0}" >/dev/null 2>&1
                confirm_auth "$mac"
            fi
        fi
    fi

    sleep "$POLL_INTERVAL"
done
