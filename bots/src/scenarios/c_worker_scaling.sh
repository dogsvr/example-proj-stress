#!/usr/bin/env bash
# Scenario C driver: run scenario B four times with workerThreadNum=1,2,4,8.
#
# Between iterations:
#   1. patch zonesvr/main_thread_config.json (workerThreadNum field)
#   2. pm2 restart exp-zonesvr
#   3. wait for /metrics on 9102 to come back up
#   4. invoke c_worker_scaling.js with --worker-thread-num <N>
#
# This script touches the live config + pm2 daemon. CLAUDE.md requires
# explicit operator authorization for that — review and run yourself.
#
# Prerequisites:
#   - example-proj already built (npm run build)
#   - pm2 daemon already running with exp-dir, exp-zonesvr, exp-battlesvr
#   - bots/ already built (npm run build inside bots/)
#   - Mongo + Redis already seeded (npm run ops -- stress:fill --count 10000)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOTS_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
EXAMPLE_PROJ_DIR="$(cd "${BOTS_DIR}/../../example-proj" && pwd)"
ZONESVR_CFG="${EXAMPLE_PROJ_DIR}/src/zonesvr/main_thread_config.json"
ZONESVR_DIST_CFG="${EXAMPLE_PROJ_DIR}/dist/zonesvr/main_thread_config.json"

DURATION_MS="${DURATION_MS:-180000}"
RAMP_MS="${RAMP_MS:-30000}"
CONCURRENCY="${CONCURRENCY:-100}"

WORKER_COUNTS=(1 2 4 8)

patch_worker_count() {
    local n="$1"
    # Use a Node one-liner to keep the JSON intact (jq dependency would be extra).
    node -e "
        const fs = require('fs');
        for (const f of ['${ZONESVR_CFG}', '${ZONESVR_DIST_CFG}']) {
            if (!fs.existsSync(f)) continue;
            const j = JSON.parse(fs.readFileSync(f, 'utf-8'));
            j.workerThreadNum = ${n};
            fs.writeFileSync(f, JSON.stringify(j, null, 4) + '\n');
            console.log('patched ' + f + ' workerThreadNum=${n}');
        }
    "
}

wait_metrics_up() {
    local url='http://127.0.0.1:9102/metrics'
    for _ in $(seq 1 30); do
        if curl -sf "$url" >/dev/null; then return 0; fi
        sleep 1
    done
    echo "ERROR: zonesvr /metrics did not come back up after restart" >&2
    exit 1
}

for n in "${WORKER_COUNTS[@]}"; do
    echo "===================================================================="
    echo " ITERATION: workerThreadNum=$n"
    echo "===================================================================="
    patch_worker_count "$n"
    pm2 restart exp-zonesvr
    wait_metrics_up
    sleep 2  # let workers register their /metrics ports

    pushd "${BOTS_DIR}" >/dev/null
    node dist/scenarios/c_worker_scaling.js \
        --concurrency "${CONCURRENCY}" \
        --duration "${DURATION_MS}" \
        --ramp "${RAMP_MS}" \
        --worker-thread-num "${n}"
    popd >/dev/null

    echo "  -> iteration ${n} done; cooling down 30s before next"
    sleep 30
done

echo
echo "All four iterations done. Check stress/reports/ for per-iteration summaries."
echo "To compare across iterations, plot bot_cycle_success_total{scenario=~\"c_worker_scaling_w.+\"}"
echo "and dogsvr_cmd_duration_ms p99 by workerThreadNum in Grafana."
