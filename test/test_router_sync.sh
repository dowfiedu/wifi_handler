#!/bin/sh
# test/test_router_sync.sh - Tests router/sync.sh functions

set -e

# Extract parse_command and is_command_safe from router/sync.sh into a test environment
eval "$(sed -n '/^parse_command() {/,/^}/p' router/sync.sh)"
eval "$(sed -n '/^parse_mac() {/,/^}/p' router/sync.sh)"
eval "$(sed -n '/^is_command_safe() {/,/^}/p' router/sync.sh)"

echo "Testing parse_command..."

# 1. Test parsing valid command with sed/jsonfilter
JSON_AUTH='{"command":"ndsctl auth 00:11:22:33:44:55 60"}'
PARSED_AUTH=$(parse_command "$JSON_AUTH")
if [ "$PARSED_AUTH" != "ndsctl auth 00:11:22:33:44:55 60" ]; then
    echo "FAIL: Expected 'ndsctl auth 00:11:22:33:44:55 60', got '$PARSED_AUTH'"
    exit 1
fi

JSON_NULL='{"command":null}'
PARSED_NULL=$(parse_command "$JSON_NULL")
if [ -n "$PARSED_NULL" ] && [ "$PARSED_NULL" != "null" ]; then
    echo "FAIL: Expected empty or 'null', got '$PARSED_NULL'"
    exit 1
fi

echo "Testing parse_mac..."

# 1. Test parsing plain text MAC
PLAIN_MAC="b6:30:f7:f7:11:60"
PARSED_PLAIN=$(parse_mac "$PLAIN_MAC")
if [ "$PARSED_PLAIN" != "b6:30:f7:f7:11:60" ]; then
    echo "FAIL: Expected 'b6:30:f7:f7:11:60', got '$PARSED_PLAIN'"
    exit 1
fi

# 2. Test parsing JSON MAC
JSON_MAC='{"mac":"b6:30:f7:f7:11:60"}'
PARSED_JSON=$(parse_mac "$JSON_MAC")
if [ "$PARSED_JSON" != "b6:30:f7:f7:11:60" ]; then
    echo "FAIL: Expected 'b6:30:f7:f7:11:60', got '$PARSED_JSON'"
    exit 1
fi

echo "Testing is_command_safe security whitelist..."

# Allowed commands
if ! is_command_safe "ndsctl auth 00:11:22:33:44:55 60"; then
    echo "FAIL: Should allow 'ndsctl auth 00:11:22:33:44:55 60'"
    exit 1
fi

if ! is_command_safe "ndsctl auth aa:bb:cc:dd:ee:ff 0"; then
    echo "FAIL: Should allow 'ndsctl auth aa:bb:cc:dd:ee:ff 0'"
    exit 1
fi

if ! is_command_safe "ndsctl deauth 00:11:22:33:44:55"; then
    echo "FAIL: Should allow 'ndsctl deauth 00:11:22:33:44:55'"
    exit 1
fi

# Disallowed / malicious commands
if is_command_safe "rm -rf /"; then
    echo "FAIL: Should reject malicious command 'rm -rf /'"
    exit 1
fi

if is_command_safe "ndsctl auth 00:11:22:33:44:55; rm -rf /"; then
    echo "FAIL: Should reject injection 'ndsctl auth ...; rm -rf /'"
    exit 1
fi

if is_command_safe "ndsctl auth invalid-mac 60"; then
    echo "FAIL: Should reject malformed MAC"
    exit 1
fi

echo "All router/sync.sh shell tests passed successfully!"
