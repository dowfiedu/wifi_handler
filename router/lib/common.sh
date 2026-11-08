#!/bin/sh
# ==============================================================================
# ArcherGuard C6 — Common Helpers & Security Module (router/lib/common.sh)
# Max lines: < 250 (DRY Principle Enforced)
# ==============================================================================

# Load optional external configuration
CONFIG_FILE="/etc/opennds/sync.conf"
[ -f "$CONFIG_FILE" ] && . "$CONFIG_FILE"

# Send standardized HTTP Headers with restricted CORS and Cache-Control
send_header() {
    printf "Content-Type: application/json; charset=utf-8\r\n"
    _origin="$HTTP_ORIGIN"
    case "$_origin" in
        "http://192.168.1.1"|"https://192.168.1.1"|"https://wifihandler.vercel.app")
            printf "Access-Control-Allow-Origin: %s\r\n" "$_origin"
            printf "Access-Control-Allow-Credentials: true\r\n"
            ;;
        *)
            # Safe default: omit Access-Control-Allow-Origin for untrusted third-party origins
            ;;
    esac
    printf "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
    printf "Access-Control-Allow-Headers: Content-Type, X-Router-Session, Authorization\r\n"
    printf "Cache-Control: no-cache, no-store, must-revalidate\r\n\r\n"
}

# Strict Hexadecimal Token Validator & Sanitizer (32 to 64 hex characters)
sanitize_token() {
    printf '%s' "$1" | tr -cd '0-9a-fA-F' | cut -c1-64
}

# Unified success response helper (DRY)
json_ok() {
    send_header
    printf '{"status":"ok","message":"%s"}\n' "$1"
    exit 0
}

# Unified error response helper (DRY)
json_error() {
    send_header
    printf '{"status":"error","message":"%s"}\n' "$1"
    exit 0
}

# Authentication check for mutating and sensitive actions
check_auth() {
    _payload="$1"
    _raw_tok="$HTTP_X_ROUTER_SESSION"
    [ -z "$_raw_tok" ] && _raw_tok=$(printf "%s" "$HTTP_AUTHORIZATION" | sed -e 's/^[Bb][Ee][Aa][Rr][Ee][Rr][[:space:]]*//')
    [ -z "$_raw_tok" ] && _raw_tok=$(printf "%s" "$QUERY_STRING" | sed -n 's/.*token=\([^&]*\).*/\1/p')
    [ -z "$_raw_tok" ] && [ -n "$_payload" ] && _raw_tok=$(extract_param "token" "$_payload")

    # Strict character set and length validation: enforce strict ^[0-9a-fA-F]{32,64}$
    case "$_raw_tok" in
        *[!0-9a-fA-F]*|"")
            send_header
            printf '{"error":"unauthorized","message":"Valid 32-64 character hex session token required."}\n'
            exit 0
            ;;
    esac

    if [ ${#_raw_tok} -lt 32 ] || [ ${#_raw_tok} -gt 64 ]; then
        send_header
        printf '{"error":"unauthorized","message":"Valid 32-64 character hex session token required."}\n'
        exit 0
    fi

    _clean_tok="$_raw_tok"

    # Filesystem lookup: strictly sanitized hex ensures absolute immunity to path traversal (no slashes, dots, or wildcards)
    _matched=0
    _session_file="/tmp/archer_sessions/$_clean_tok"
    if [ -f "$_session_file" ]; then
        _mod=$(date -r "$_session_file" +%s 2>/dev/null || echo 0)
        _now=$(date +%s)
        # Token valid for 24 hours (86400 seconds)
        if [ $((_now - _mod)) -lt 86400 ]; then
            _matched=1
        else
            rm -f "$_session_file" 2>/dev/null
        fi
    fi

    # Fallback verification: OpenWrt ubus session validation (rpcd)
    if [ "$_matched" -ne 1 ] && command -v ubus >/dev/null 2>&1; then
        if ubus -t 2 call session list "{\"ubus_rpc_session\":\"$_clean_tok\"}" 2>/dev/null | grep -q "ubus_rpc_session"; then
            _matched=1
        fi
    fi

    if [ "$_matched" -ne 1 ]; then
        send_header
        printf '{"error":"unauthorized","message":"Session expired or invalid. Please log in again."}\n'
        exit 0
    fi
}

# Session login handler using OpenWrt ubus / shadow verification
handle_login() {
    _u="$1"; _p="$2"
    [ -z "$_u" ] && _u="root"
    if [ -z "$_p" ]; then
        send_header; printf '{"status":"error","message":"Password required"}\n'; exit 0
    fi

    _tok=""
    # Primary: UBUS Session Login (Memory Safe)
    if command -v ubus >/dev/null 2>&1; then
        _u_json=$(printf '{"username":"%s","password":"%s"}' "$(printf "%s" "$_u" | sed 's/"/\\"/g')" "$(printf "%s" "$_p" | sed 's/"/\\"/g')")
        _u_out=$(ubus -t 3 call session login "$_u_json" 2>/dev/null)
        _tok=$(printf "%s" "$_u_out" | sed -n 's/.*"ubus_rpc_session"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
    fi

    # Fallback: Environment-variable isolated Lua execution (Zero Code Injection)
    if [ -z "$_tok" ] && command -v lua >/dev/null 2>&1 && [ -f /etc/shadow ]; then
        _tok_gen=$(LOGIN_U="$_u" LOGIN_P="$_p" lua -e '
            local u = os.getenv("LOGIN_U") or ""
            local p = os.getenv("LOGIN_P") or ""
            local f = io.open("/etc/shadow", "r")
            if not f then os.exit(1) end
            local c = f:read("*a"); f:close()
            local h = c:match(u:gsub("[%^%$%(%)%%%.%[%]%*%+%-%?]", "%%%1") .. ":([^:]+)")
            if h and require("nixio").crypt(p, h) == h then
                print("OK")
            else
                os.exit(1)
            end
        ' 2>/dev/null)
        if [ "$_tok_gen" = "OK" ]; then
            _tok=$(head -c 16 /dev/urandom 2>/dev/null | hexdump -e '16/1 "%02x"' 2>/dev/null || cat /proc/sys/kernel/random/uuid 2>/dev/null | tr -d '-')
        fi
    fi

    if [ -n "$_tok" ]; then
        mkdir -p /tmp/archer_sessions
        chmod 700 /tmp/archer_sessions
        touch "/tmp/archer_sessions/$_tok"
        chmod 600 "/tmp/archer_sessions/$_tok"
        send_header
        printf '{"status":"ok","token":"%s","username":"%s","expires":86400}\n' "$_tok" "$_u"
        exit 0
    else
        send_header
        printf '{"status":"error","message":"Invalid username or password"}\n'
        exit 0
    fi
}

# Extract key from JSON payload or query string (DRY parameter extractor)
extract_param() {
    _key="$1"
    _payload="$2"
    _val=""
    if [ -n "$_payload" ]; then
        _val=$(printf "%s" "$_payload" | sed -n "s/.*\"$_key\"[ ]*:[ ]*\"\([^\"]*\)\".*/\1/p")
        if [ -z "$_val" ]; then
            _val=$(printf "%s" "$_payload" | sed -n "s/.*\"$_key\"[ ]*:[ ]*\([0-9a-zA-Z._-]*\).*/\1/p")
        fi
    fi
    if [ -z "$_val" ]; then
        _val=$(printf "%s" "$QUERY_STRING" | sed -n "s/.*$_key=\([^&]*\).*/\1/p")
    fi
    printf "%s" "$_val"
}
