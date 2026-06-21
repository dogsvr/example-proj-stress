# k6 scripts for dogsvr-org HTTP endpoints

Currently a single script — `dir_query.js` — driving the `dir` process's
`DIR_QUERY_ZONE_LIST` endpoint. tsrpc-WS endpoints (zonesvr) are NOT exercised
by k6 because tsrpc's WebSocket framing is non-trivial and the Node bots in
`../bots/` cover them with the official client.

## Install k6

```sh
# Ubuntu/Debian
sudo gpg -k && sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt update && sudo apt install k6

# macOS
brew install k6
```

## Run

```sh
# Default 50 VUs, ramp 20s + hold 60s + drain 15s
k6 run dir_query.js

# Tune via env
STRESS_VUS=200 STRESS_DURATION=120s STRESS_RAMP=30s k6 run dir_query.js

# Different host
DIR_HOST=10.0.0.5 DIR_PORT=10000 k6 run dir_query.js
```

## What it tests

Each VU iteration POSTs `tsrpc-over-HTTP` `ReqCommon` to `dir:10000/Common` with
`cmdId=DIR_QUERY_ZONE_LIST`. The handler reads `zone_coll` from MongoDB and
returns the zone list. This exercises:

- `dir` process main thread routing (`dogsvr_cmd_duration_ms{cmdId="10001"}`)
- `dir` worker thread Mongo query (`mongo_op_duration_ms{coll="zone_coll"}`)
- HTTP CL accept queue + connection churn

## Thresholds

The script fails (non-zero exit) if:

- `http_req_failed > 1%`
- `http_req_duration p99 > 1s`

Both are conservative; tighten when establishing baseline.

## Why no tsrpc-WS k6 script

tsrpc's WS protocol packs a custom 32-bit length prefix + service id +
sequence number around each message. k6's `k6/ws` only writes raw frames,
so a script would need to re-implement the framing, the service map lookup,
and ApiReturn parsing. Net loss vs. just running the Node bots in
`../bots/`, which use the official `tsrpc` Node SDK.
