# Stress test observability stack

OTLP-compatible single-host backend for the dogsvr-org stress harness, served
by the [`grafana/otel-lgtm`](https://github.com/grafana/docker-otel-lgtm)
single-container all-in-one (Loki + Grafana + Tempo + Prometheus + OTel
Collector). One `docker run` brings up metrics, traces, and logs together.

## Setup

```sh
cd /data/dogsvr-org/example-proj-stress
docker run -d --name otel-lgtm \
    --network=host \
    -v $(pwd)/observability/prometheus.yml:/otel-lgtm/prometheus.yaml:ro \
    -v $(pwd)/observability/dashboards:/otel-lgtm/grafana/conf/provisioning/dashboards/custom:ro \
    -v $(pwd)/observability/dashboards-provider.yaml:/otel-lgtm/grafana/conf/provisioning/dashboards/custom.yaml:ro \
    grafana/otel-lgtm:latest
```

That brings up:

- Grafana on `http://127.0.0.1:3000` (anonymous Viewer; admin/admin for edits)
- Prometheus on `http://127.0.0.1:9090` (scraping host services via `--network=host`)
- Tempo on `http://127.0.0.1:3200` (queried through Grafana Explore)
- Loki on `http://127.0.0.1:3100` (queried through Grafana Explore)
- OTLP receivers: gRPC `:4317`, HTTP `:4318` (used by bots and svr OTLP exporters)

Grafana auto-provisions Tempo / Loki / Prometheus datasources (built-in) and
imports the three dashboards in `dashboards/` into folder `dogsvr stress` via
`dashboards-provider.yaml`.

## Files

- `prometheus.yml` — scrape config, mounted to `/otel-lgtm/prometheus.yaml`
- `dashboards/` — Grafana dashboard JSONs (provisioned)
- `dashboards-provider.yaml` — Grafana dashboard provider, mounted to
  `/otel-lgtm/grafana/conf/provisioning/dashboards/custom.yaml`

## Scrape topology

`prometheus.yml` scrapes:

| job                          | targets                           | interval |
|------------------------------|-----------------------------------|----------|
| dogsvr-dir-main              | 127.0.0.1:9101                    | 5s       |
| dogsvr-dir-worker            | 127.0.0.1:9112, :9113             | 5s       |
| dogsvr-zonesvr-main          | 127.0.0.1:9102                    | 5s       |
| dogsvr-zonesvr-worker        | 127.0.0.1:9123, :9124             | 5s       |
| dogsvr-battlesvr-main        | 127.0.0.1:9103                    | 2s       |
| dogsvr-battlesvr-worker      | 127.0.0.1:9133                    | 2s       |
| stress-bots                  | 127.0.0.1:9201                    | 5s       |

Worker ports follow `<portBase> + <node:worker_threads.threadId>`. `threadId` is
incremented globally per process and counts framework-internal Workers too: zonesvr
and battlesvr run `log.mode="central"`, so `@dogsvr/logger` spawns a central log
Worker that takes `threadId=1`, shifting business workers to `threadId=2..N`. dir
runs `log.mode="inline"` and is not affected. See `RUNBOOK.md` §"Known issue:
central log mode shifts worker /metrics ports" for the full breakdown and
remediation options.

Adjust target lists in `prometheus.yml` if `workerThreadNum` changes — the
operator runs scenario C iterations manually and updates this file accordingly
(the driver script `c_worker_scaling.sh` does not rewrite it).

## Dashboards

- `dogsvr_overview.json` — cmd p99/QPS, txn pending/timeout, eventloop lag,
  mongo/redis op p99, process CPU/RSS.
- `colyseus_battle.json` — tick p50/p95/p99 vs the 16.67ms 60fps budget,
  active rooms, total clients, broadcast rate, battlesvr eventloop lag.
- `worker_scaling.json` — per-worker pending requests, total QPS, p99 by
  cmdId. Used to spot main-thread bottlenecks when the QPS curve plateaus.

These are reusable in production: metric names and labels are not
stress-specific. Drop the JSONs into a production Grafana with a Prometheus
datasource named `Prometheus` and they work unchanged.

## Teardown

```sh
docker stop otel-lgtm && docker rm otel-lgtm
```
