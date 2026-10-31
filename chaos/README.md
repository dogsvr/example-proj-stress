# chaos

Fault injection for zonesvr worker supervision (dogsvr worker respawn, ready-gated routing, abortable hot update). Test-only tooling: nothing here ships with example-proj.

## Pieces

- `zonesvr_chaos_worker.js` — a zonesvr worker entry that runs the real `example-proj/dist/servers/zonesvr/zonesvr_logic.js` and injects faults per worker slot from marker files in `/tmp/dogsvr-chaos/`:

  | marker | effect |
  |---|---|
  | `loadfail-<slot>` | throw while the worker file loads |
  | `initfail-<slot>` | throw after the real init |
  | `inithang-<slot>` | never finish init (after the real init connected Redis/MongoDB) |
  | `exit-<slot>`, `exit-t<threadId>` | one-shot `process.exit(9)` once the worker is ready (polled every 100 ms) |

  Every worker appends `{ts, e, idx, tid, ver}` lines (`load`, `init_start`, `ready`, `exit`, …) to `/tmp/dogsvr-chaos/events.ndjson`; `ver` is read from `/tmp/dogsvr-chaos/version` when the worker loads, so a report can tell which code generation each slot runs.

- `run_supervision.py` — runs one case end to end: points the dist zonesvr config at the shim, restarts `exp-zonesvr`, drives scenario F bots, injects faults, checks the outcome against Prometheus, the shim events and the zonesvr main-thread log, and writes `reports/<UTC>-supervision-<case>/summary.md` + `data.json`. The dist configs are copied back from `src/` when the case ends.

## Usage

Prerequisites are the usual stress setup (see [`../RUNBOOK.md`](../RUNBOOK.md)): pm2 apps running, Prometheus on `:9090`, bots built.

```sh
cd example-proj-stress
python3 chaos/run_supervision.py crash              # serving worker crashes, backoff ladder, both slots down
python3 chaos/run_supervision.py rolling            # rolling hot update: success / abort / mixed version / crash mid-update
python3 chaos/run_supervision.py allatonce          # allAtOnce hot update
python3 chaos/run_supervision.py startup-loadfail   # one slot fails to load at startup
python3 chaos/run_supervision.py startup-inithang   # one slot never finishes init at startup
python3 chaos/run_supervision.py startup-allfail    # every slot fails init
python3 chaos/run_supervision.py soak --updates 20  # memory/threads across many hot updates (no shim)
python3 chaos/run_supervision.py soak --control     # same timeline without hot updates, as the soak baseline
python3 chaos/run_supervision.py soak --tail 180    # keep the load running 180 s after the last hot update
python3 chaos/run_supervision.py hotupdate-perf --label new   # two hot updates under the standard F 1000 load
```

Cases restart `exp-zonesvr` (`hotupdate-perf` restarts all three apps) and rewrite `example-proj/dist/servers/zonesvr/*.json`; don't run them alongside other load.

`hotupdate-perf` runs whatever is in `dogsvr/dist`; to compare dogsvr builds, swap that directory between runs and pass a different `--label`.
