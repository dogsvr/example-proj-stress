# ghz configs for direct gRPC stress

[ghz](https://ghz.sh/) is a single-binary gRPC load tester. Two configs here:

| File | Target | Purpose |
|---|---|---|
| `battlesvr_start_battle.yaml` | `127.0.0.1:30001` | BATTLE_START_BATTLE direct hit on battlesvr's gRPC server |
| `zonesvr_inner.yaml` | `127.0.0.1:20001` | ZONE_HEARTBEAT on zonesvr's server-server gRPC port |

## Install ghz

```sh
# Linux x86_64
curl -L https://github.com/bojand/ghz/releases/download/v0.120.0/ghz-linux-x86_64.tar.gz | tar -xz
sudo mv ghz /usr/local/bin/

# macOS
brew install ghz
```

## Run

```sh
cd /data/dogsvr-org/example-proj-stress
ghz --config ghz/battlesvr_start_battle.yaml

# Override workload shape
ghz --config ghz/battlesvr_start_battle.yaml --concurrency 200 --duration 60s
```

## Verify cmdId values

Both configs hard-code `cmd_id` integers in the request body. If you change
`example-proj/src/protocols/cmd_id.ts` (e.g. renumber a command), update the
configs to match. Otherwise the handler returns "no handler for cmdId" and
all calls fail.

| cmd | id |
|---|---|
| `BATTLE_START_BATTLE` | 30001 |
| `ZONE_HEARTBEAT` | check `cmd_id.ts` (added by example-proj-client; may not exist) |

If `ZONE_HEARTBEAT` isn't a real cmdId in your tree, `zonesvr_inner.yaml` will
return errors — replace the `cmd_id` field with any zonesvr-handled cmd
that's safe to retry without state side effects (e.g. `ZONE_QUERY_RANK_LIST`
with rankId=1, after running stress:fill).
