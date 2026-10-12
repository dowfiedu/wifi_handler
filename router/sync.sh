#!/bin/sh
# ==============================================================================
# OpenWrt openNDS Sync Daemon (router/sync.sh)
#
# Periodically polls the Vercel serverless /api/poll endpoint for pending
# router commands (ndsctl auth / deauth) authorized via the Telegram Bot.
#
# Compatibility: POSIX /bin/sh (BusyBox ash on OpenWrt).
# ==============================================================================

# ------------------------------------------------------------------------------
# 1. Configuration & Defaults
# ------------------------------------------------------------------------------
# Optionally load configuration from file if present
[ -f /etc/opennds/sync.conf ] && . /etc/opennds/sync.conf
[ -f ./sync.conf ] && . ./sync.conf

API_URL="${API_URL:-https://your-deployment.vercel.app/api/poll}"
ROUTER_SECRET_KEY="${ROUTER_SECRET_KEY:-change_this_secret_key}"
POLL_INTERVAL="${POLL_INTERVAL:-5}"
LOG_TAG="${LOG_TAG:-opennds-sync}"

# ------------------------------------------------------------------------------
# 2. Logging Helpers
# ------------------------------------------------------------------------------
log_info() {
    printf "[%s] [INFO] %s\n" "$(date '+%Y-%m-%d %H:%M:%S')" "$1"
    if command -v logger >/dev/null 2>&1; then
        logger -t "$LOG_TAG" "[INFO] $1"
    fi
}

log_warn() {
    printf "[%s] [WARN] %s\n" "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >&2
    if command -v logger >/dev/null 2>&1; then
        logger -t "$LOG_TAG" "[WARN] $1"
    fi
}

log_error() {
    printf "[%s] [ERROR] %s\n" "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >&2
    if command -v logger >/dev/null 2>&1; then
        logger -t "$LOG_TAG" "[ERROR] $1"
    fi
}

# ------------------------------------------------------------------------------
# 3. Environment & Dependency Checks
# ------------------------------------------------------------------------------
if ! command -v curl >/dev/null 2>&1; then
    log_error "'curl' is required but not installed. Install via: opkg update && opkg install curl"
    exit 1
fi

if ! command -v ndsctl >/dev/null 2>&1; then
    log_warn "'ndsctl' was not found in PATH. Commands will be simulated in dry-run mode if openNDS is not installed."
fi

# ------------------------------------------------------------------------------
# 4. JSON Parser Helper
# Extracts the "command" field from { "command": "..." } or handles null.
# Prioritizes OpenWrt's native 'jsonfilter', falls back to 'jq', then POSIX 'sed'.
# ------------------------------------------------------------------------------
parse_command() {
    _raw_json="$1"

    if command -v jsonfilter >/dev/null 2>&1; then
        printf '%s' "$_raw_json" | jsonfilter -e '@.command'
    elif command -v jq >/dev/null 2>&1; then
        printf '%s' "$_raw_json" | jq -r '.command // empty'
    else
        # Pure POSIX sed extraction
        # Matches "command": "value" and ignores "command": null
        printf '%s' "$_raw_json" | sed -n 's/.*"command"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p'
    fi
}

# ------------------------------------------------------------------------------
# 5. Security & Validation Filter
# Ensures commands strictly match allowed openNDS syntax before execution:
#  - ndsctl auth <MAC> <minutes>
#  - ndsctl deauth <MAC>
# ------------------------------------------------------------------------------
is_command_safe() {
    _cmd="$1"

    # Match auth: ndsctl auth xx:xx:xx:xx:xx:xx <numbers>
    case "$_cmd" in
        ndsctl\ auth\ [0-9a-fA-F][0-9a-fA-F]:[0-9a-fA-F][0-9a-fA-F]:[0-9a-fA-F][0-9a-fA-F]:[0-9a-fA-F][0-9a-fA-F]:[0-9a-fA-F][0-9a-fA-F]:[0-9a-fA-F][0-9a-fA-F]\ [0-9]*)
            return 0
            ;;
        ndsctl\ deauth\ [0-9a-fA-F][0-9a-fA-F]:[0-9a-fA-F][0-9a-fA-F]:[0-9a-fA-F][0-9a-fA-F]:[0-9a-fA-F][0-9a-fA-F]:[0-9a-fA-F][0-9a-fA-F]:[0-9a-fA-F][0-9a-fA-F])
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

# ------------------------------------------------------------------------------
# 6. Signal Handling
# ------------------------------------------------------------------------------
cleanup() {
    log_info "Received termination signal. Stopping openNDS sync daemon."
    exit 0
}
trap cleanup INT TERM

# ------------------------------------------------------------------------------
# 7. Main Polling Loop
# ------------------------------------------------------------------------------
log_info "Starting openNDS sync service..."
log_info "Polling endpoint: $API_URL every ${POLL_INTERVAL}s"

while true; do
    # Perform HTTP GET poll with timeout and secret authentication header
    response=$(curl -s -f -m 10 \
        -H "x-router-secret: $ROUTER_SECRET_KEY" \
        -H "Accept: application/json" \
        "$API_URL" 2>/dev/null)
    curl_exit=$?

    if [ $curl_exit -ne 0 ]; then
        log_warn "Poll request failed (curl exit code: $curl_exit). Check network, URL, or x-router-secret."
    elif [ -n "$response" ]; then
        # Parse command from response JSON
        target_cmd=$(parse_command "$response")

        if [ -n "$target_cmd" ] && [ "$target_cmd" != "null" ]; then
            log_info "Received command from queue: $target_cmd"

            # Strict security verification
            if is_command_safe "$target_cmd"; then
                if command -v ndsctl >/dev/null 2>&1; then
                    exec_output=$($target_cmd 2>&1)
                    exec_code=$?
                    if [ $exec_code -eq 0 ]; then
                        log_info "Successfully executed: '$target_cmd' [Output: $exec_output]"
                    else
                        log_warn "Command returned error ($exec_code): '$target_cmd' [Output: $exec_output]"
                    fi
                else
                    log_info "[DRY-RUN] Simulating command execution: $target_cmd"
                fi
            else
                log_error "SECURITY ALERT: Rejected unauthorized or malformed command: '$target_cmd'"
            fi
        fi
    fi

    # Wait for the next poll cycle
    sleep "$POLL_INTERVAL"
done
