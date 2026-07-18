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

## Signal flow

All three signals (metrics, traces, logs) push via OTLP HTTP to `:4318`. The
`otel-lgtm` container's built-in OTel Collector forwards metrics to
Prometheus's OTLP receiver (`--web.enable-otlp-receiver`), traces to Tempo,
and logs to Loki. No `prometheus.yml` is mounted — the container's default
config (no scrape jobs) suffices.

## Naming

SDK-side instruments follow OTel conventions: instrument names carry no
physical-unit suffix and pass `unit` (`ms` / `s` / `By`) explicitly. The
Prom OTLP receiver's default `translation_strategy=UnderscoreEscapingWithSuffixes`
appends the unit suffix (`_milliseconds` / `_seconds` / `_bytes`) and the
type suffix (`_total` for counters, `_bucket`/`_count`/`_sum` for histograms)
on ingest. Dashboard PromQL queries the post-translation names — e.g.
`dogsvr_cmd_duration_milliseconds_bucket`, `process_cpu_time_seconds_total`.

## Files

- `dashboards/` — Grafana dashboard JSONs (provisioned)
- `dashboards-provider.yaml` — Grafana dashboard provider, mounted to
  `/otel-lgtm/grafana/conf/provisioning/dashboards/custom.yaml`

## Dashboards

- `dogsvr_overview.json` — cmd p99/QPS, txn pending/timeout, eventloop lag,
  mongo/redis op p99, process CPU/RSS.
- `colyseus_battle.json` — tick p50/p95/p99 vs the 16.67ms 60fps budget,
  active rooms, total clients, broadcast rate, battlesvr eventloop lag.
- `worker_scaling.json` — per-worker pending requests, total QPS, p99 by
  cmdId. Used to spot main-thread bottlenecks when the QPS curve plateaus.
- `profile_flamegraph.json` — Pyroscope continuous CPU flame graphs. Main
  thread, worker threads (aggregate), and per-worker breakdown, plus a diff
  panel, a wall:samples:count comparison panel, and heap (inuse_space) flames
  for main + per-worker. Variables: `$svr` (dir/zonesvr/battlesvr),
  `$worker_index`. Requires `profiling.enabled` in the corresponding svr's
  `main_thread_config.json` / `worker_thread_config.json`.

These are reusable in production: metric names and labels are not
stress-specific. Drop the JSONs into a production Grafana with a Prometheus
datasource named `Prometheus` and they work unchanged.

## Teardown

```sh
docker stop otel-lgtm && docker rm otel-lgtm
```
