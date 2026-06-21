#!/usr/bin/env bash
# Scenario D driver: run scenario D's bot script and trigger pm2 hot update
# at the configured offset.
#
# Background-launches the bot script, waits TRIGGER_AT seconds, then runs
# `pm2 trigger exp-zonesvr hotUpdate` and waits for the bots to finish.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOTS_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"

DURATION_MS="${DURATION_MS:-300000}"
RAMP_MS="${RAMP_MS:-30000}"
CONCURRENCY="${CONCURRENCY:-100}"
TRIGGER_AT_MS="${TRIGGER_AT_MS:-120000}"

pushd "${BOTS_DIR}" >/dev/null
echo "Launching scenario D bots in background..."
node dist/scenarios/d_hot_update.js \
    --concurrency "${CONCURRENCY}" \
    --duration "${DURATION_MS}" \
    --ramp "${RAMP_MS}" \
    --trigger-at "${TRIGGER_AT_MS}" &
BOT_PID=$!
popd >/dev/null

# Wait till the planned trigger moment.
sleep $((TRIGGER_AT_MS / 1000))

echo "Triggering pm2 trigger exp-zonesvr hotUpdate"
pm2 trigger exp-zonesvr hotUpdate || echo "WARN: pm2 trigger returned non-zero"

# Wait for the bot script to finish naturally (durationMs after start, minus
# the trigger offset we already waited for).
echo "Waiting for bots to finish ($((DURATION_MS - TRIGGER_AT_MS)) ms remaining)..."
wait "${BOT_PID}"

echo
echo "Done. Report under stress/reports/."
