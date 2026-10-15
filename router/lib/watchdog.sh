#!/bin/sh
# ==============================================================================
# ArcherGuard C6 — Autonomous Self-Healing & Router Watchdog (router/lib/watchdog.sh)
#
# Hardware: TP-Link Archer C6 v3 (MediaTek MT7621DAT, OpenWrt 21.02+)
# Max lines: < 250 (DRY Principle Enforced)
# ==============================================================================

BACKUP_DIR="/etc/archer_guard_backup"
LOG_TAG="archer_watchdog"

# 1. Ensure pristine baseline configurations are backed up
backup_baseline() {
    [ ! -d "$BACKUP_DIR" ] && mkdir -p "$BACKUP_DIR"
    for _cfg in dhcp network firewall wireless; do
        if [ -f "/etc/config/$_cfg" ] && [ ! -f "$BACKUP_DIR/$_cfg" ]; then
            cp -p "/etc/config/$_cfg" "$BACKUP_DIR/$_cfg"
            logger -t "$LOG_TAG" "Backed up pristine baseline for /etc/config/$_cfg"
        fi
    done
}

# 2. Check and heal dnsmasq (DHCP & DNS gateway)
heal_dnsmasq() {
    if ! pidof dnsmasq >/dev/null 2>&1; then
        logger -t "$LOG_TAG" "[ALERT] dnsmasq is NOT running! Initiating emergency diagnostics..."
        if command -v dnsmasq >/dev/null 2>&1 && ! dnsmasq --test >/dev/null 2>&1; then
            logger -t "$LOG_TAG" "[FATAL] dnsmasq syntax test failed! Corrupted config detected. Restoring baseline backup..."
            if [ -f "$BACKUP_DIR/dhcp" ]; then
                cp -f "$BACKUP_DIR/dhcp" /etc/config/dhcp
                logger -t "$LOG_TAG" "Restored clean /etc/config/dhcp from backup."
            else
                uci revert dhcp 2>/dev/null
            fi
        fi
        /etc/init.d/dnsmasq restart >/dev/null 2>&1
        sleep 1
        if pidof dnsmasq >/dev/null 2>&1; then
            logger -t "$LOG_TAG" "[SUCCESS] dnsmasq successfully revived by watchdog!"
        else
            logger -t "$LOG_TAG" "[CRITICAL] Unable to start dnsmasq. Emergency revert to defaults."
        fi
    fi
}

# 3. Check and heal uhttpd web server
heal_uhttpd() {
    if ! pidof uhttpd >/dev/null 2>&1; then
        logger -t "$LOG_TAG" "[WARN] uhttpd web server is not running. Reviving..."
        /etc/init.d/uhttpd restart >/dev/null 2>&1
    fi
}

# 4. Enforce MediaTek MT7621 Silicon Safeguards (Disable HW offload lockup)
enforce_silicon_safeguards() {
    _hw_offload=$(uci get firewall.@defaults[0].flow_offloading_hw 2>/dev/null)
    if [ "$_hw_offload" = "1" ]; then
        logger -t "$LOG_TAG" "[PROTECTION] flow_offloading_hw detected as 1! MT7621 queue lockup prevention triggered."
        uci set firewall.@defaults[0].flow_offloading_hw='0'
        uci commit firewall && /etc/init.d/firewall reload >/dev/null 2>&1
    fi
}

# 5. Prevent RAM Exhaustion & Kernel OOM Panics
check_memory_pressure() {
    _avail_kb=0
    if [ -f /proc/meminfo ]; then
        _avail_kb=$(awk '/MemAvailable/ {print $2}' /proc/meminfo)
        [ -z "$_avail_kb" ] && _avail_kb=$(awk '/MemFree/ {f=$2} /Cached/ {c=$2} END {print f+c}' /proc/meminfo)
    fi
    if [ "${_avail_kb:-99999}" -lt 8192 ]; then
        logger -t "$LOG_TAG" "[WARN] Critically low memory (${_avail_kb} kB). Dropping kernel caches..."
        sync && echo 3 > /proc/sys/vm/drop_caches 2>/dev/null
    fi
}

# 6. Clean stale execution locks
clean_stale_locks() {
    if [ -d "/tmp/c6_status.lock" ]; then
        _now=$(date +%s)
        _lock_time=$(date -r /tmp/c6_status.lock +%s 2>/dev/null || echo "$_now")
        if [ $((_now - _lock_time)) -gt 30 ]; then
            rm -rf /tmp/c6_status.lock
            logger -t "$LOG_TAG" "Purged stale status cache lock."
        fi
    fi
}

# 7. Real-Time Internet WAN LED Controller (Green=Online, Amber/Red=Offline)
check_wan_led() {
    _online=0
    if ip route | grep -q "^default " 2>/dev/null; then
        if ping -q -c 1 -W 2 1.1.1.1 >/dev/null 2>&1 || ping -q -c 1 -W 2 8.8.8.8 >/dev/null 2>&1; then
            _online=1
        fi
    fi

    if [ "$_online" = "1" ]; then
        echo 0 > /sys/class/leds/amber:wan/brightness 2>/dev/null
        echo 1 > /sys/class/leds/green:wan/brightness 2>/dev/null
    else
        echo 0 > /sys/class/leds/green:wan/brightness 2>/dev/null
        echo 1 > /sys/class/leds/amber:wan/brightness 2>/dev/null
        logger -t "$LOG_TAG" "[WAN] Internet unreachable! WAN LED set to AMBER/RED."
    fi
}

# Main Entry
case "$1" in
    "init"|"backup")
        backup_baseline
        check_wan_led ;;
    "led_check")
        check_wan_led ;;
    "run"|*)
        backup_baseline
        heal_dnsmasq
        heal_uhttpd
        enforce_silicon_safeguards
        check_memory_pressure
        clean_stale_locks
        check_wan_led ;;
esac
exit 0
