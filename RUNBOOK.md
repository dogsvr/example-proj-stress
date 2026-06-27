# Stress 运行手册

单机 Linux 环境下跑 dogsvr-org 压测场景的端到端操作手册。OTLP 三信号
(metrics + traces + logs)backend 用 `grafana/otel-lgtm` 单容器
(LGTMP all-in-one:Loki + Grafana + Tempo + Prometheus + OTel Collector)。
云上部署不在范围,见末尾 Production Notes。

## 约定

- 命令默认在 `example-proj-stress` 仓根执行,先 `cd <polyrepo-root>/example-proj-stress`
- 跨仓引用用 `../<sibling>` 形式(例如 `../example-proj`、`../dogsvr`)
- macOS / Windows Docker Desktop 把下文 `--network=host` 替换为
  `--add-host=host.docker.internal:host-gateway`(本文不展开)

## 前置检查清单

执行任何启动前,逐项确认:

```sh
# 1. dogsvr build 通过,tracing 接口已编译
ls ../dogsvr/dist/main_thread/tracing.d.ts
ls ../dogsvr/dist/worker_thread/tracing.d.ts

# 2. example-proj build 通过,otel SDK 已装
ls ../example-proj/dist/shared/otel_metrics.js
ls ../example-proj/dist/shared/otel_tracing.js
ls ../example-proj/node_modules/@opentelemetry/sdk-metrics/

# 3. example-proj 的 dogsvr link 是本地工作树
readlink ../example-proj/node_modules/@dogsvr/dogsvr
#   预期: ../../../dogsvr 或类似

# 4. bots build 通过
ls bots/dist/scenarios/b_login_battle_end.js
ls bots/dist/otel_tracing_client.js

# 5. Redis + MongoDB 在 127.0.0.1
redis-cli -h 127.0.0.1 -p 6379 ping       # 预期: PONG
echo 'db.runCommand({ping:1})' | mongosh --quiet 127.0.0.1:27017/dogsvr-example-proj

# 6. Docker 可用 (单机 backend 走容器)
docker version >/dev/null && echo "docker OK"

# 7. otel-lgtm 镜像就位 (首次约 800MB 下载)
docker images grafana/otel-lgtm --format '{{.Repository}}:{{.Tag}}' | grep -q otel-lgtm \
    || docker pull grafana/otel-lgtm:latest

# 8. 端口未被占用 (业务进程 OTLP push 模式不再 listen 9101-9133;只看观测栈端口)
ss -tln | grep -E ':(3000|3100|3200|4317|4318|9090)\b' \
    && echo "WARN: 有端口已占用"
```

任一失败 → 修后重跑,**不要继续**。

---

## 启动顺序

按依赖关系,**一次跑通的最小路径**(观测栈先起,业务进程的 OTLP push 才有去处):

### 1. 启动观测栈(单容器 LGTMP + OTel Collector)

在 `example-proj-stress` 仓根:

```sh
docker run -d --name otel-lgtm \
    --network=host \
    -v $(pwd)/observability/dashboards:/otel-lgtm/grafana/conf/provisioning/dashboards/custom:ro \
    -v $(pwd)/observability/dashboards-provider.yaml:/otel-lgtm/grafana/conf/provisioning/dashboards/custom.yaml:ro \
    grafana/otel-lgtm:latest

# 等启动 (约 20s)
until docker logs otel-lgtm 2>&1 | grep -q 'The OpenTelemetry collector and the Grafana LGTM stack are up and running'; do
    sleep 2
done && echo "lgtm OK"

# 健康验证
curl -sf http://127.0.0.1:9090/-/healthy && echo "prom OK"
curl -sf http://127.0.0.1:3000/api/health && echo "grafana OK"
curl -sf http://127.0.0.1:3200/ready      && echo "tempo OK"
curl -sf http://127.0.0.1:3100/ready      && echo "loki OK"
```

浏览器进 `http://127.0.0.1:3000/dashboards` 看 "dogsvr stress" 文件夹;
`/explore` 切 Tempo / Loki datasource 看 traces / logs。Grafana 默认账号
`admin/admin`(只在编辑 dashboard 时需要)。

### 2. 启动 example-proj 三进程

```sh
cd ../example-proj
pm2 start ecosystem.config.js
pm2 ls
```

预期:`exp-dir` `exp-zonesvr` `exp-battlesvr` 三个 online。

### 3. 验证 OTLP push 通路

业务侧通过 `@opentelemetry/exporter-metrics-otlp-http` push 到容器内 OTel
Collector(`http://127.0.0.1:4318/v1/metrics`),collector 转发到 Prometheus
的 OTLP receiver。等 ~10s 让首次 push 落 prom,然后:

```sh
# OTLP HTTP endpoint 通(POST 没 body 应返回 415,而不是 ECONNREFUSED)
curl -sf -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:4318/v1/metrics
#   预期: 415

# 业务侧指标已经入 prom
curl -s 'http://127.0.0.1:9090/api/v1/query?query=dogsvr_cmd_duration_milliseconds_count' \
    | grep -q '"status":"success"' && echo "metrics OK"
```

失败 → `pm2 logs <name>` 或 `docker logs otel-lgtm`。

### 4. 数据预填(只需一次)

```sh
cd ../example-proj
npm run ops -- stress:fill --count 10000 --zone-id 1 --yes
```

预期输出:
```
mongo: upserted=10000 matched=0
redis: zadd=10000 key=rank|1|allzone
done.
```

验证:
```sh
echo 'db.role_coll.countDocuments({openId: /^stress_/})' | mongosh --quiet 127.0.0.1:27017/dogsvr-example-proj
#   预期: 10000
```

---

## 跑场景

**强烈建议先跑场景 B 的最小化版本验证整链**。整链通过再上规模 / 跑其他场景。

### 烟雾测试: 场景 B 最小化(5 并发, 30 秒)

```sh
cd bots
node dist/scenarios/b_login_battle_end.js \
    --concurrency 5 --duration 30000 --ramp 5000 \
    2> /tmp/stress-b-stderr.log
```

`2> /tmp/stress-b-stderr.log` 把 bot stderr 落盘,把已知噪声(详见 §"已知噪声:
bot stderr refId not found")从终端隔离;终端只剩 bot pino 业务日志(stdout)。

bot 跑的同时打开浏览器看 Grafana,**三信号都要看到**:

- **metrics**(Grafana dashboard):
    - `dogsvr Overview` 应该出现 `ZONE_LOGIN` `ZONE_START_BATTLE` `ZONE_BATTLE_END_NTF` 的 QPS 曲线
    - `Colyseus Battle` 应该有 `state_sync` tick p99 曲线
- **traces**(Grafana → Explore → Tempo datasource):
    - service dropdown 应有 `stress-bots` / `dir` / `zonesvr` / `battlesvr`
    - 选 `stress-bots`,搜最近 trace,展开应看到完整 span 树:
      `bot.ZONE_LOGIN` → `tsrpc.ZONE_LOGIN` (zonesvr) → `worker.ZONE_LOGIN` (zonesvr worker)
    - `bot.ZONE_START_BATTLE` 应有 grpc 跨进程 child(zonesvr → battlesvr)
- **logs**(Grafana → Explore → Loki datasource):
    - `{service="zonesvr"}` 应有 NDJSON 业务日志
    - 展开任一条,字段里应能看到 `traceId` / `spanId`(central log mode 注入)
    - dir 走 inline mode,**不发** OTLP logs,只在落盘文件里有,这是预期

已知限制:
- `mongo` / `redis` 子 span 没接 auto-instrumentation,只能看到 framework 起的 span
- `colyseus join` 没传 traceparent(SDK 没标准 metadata 接口),battlesvr 内
  `worker.<cmdId>` span 会 disconnect 成 root

跑完检查:
```sh
cat reports/*-b_login_battle_end/summary.md
```

通过 → 继续大规模 / 其他场景。报错 → 见 Troubleshooting。

### 场景 A: Colyseus 房间承载上限

```sh
cd bots
node dist/scenarios/a_room_capacity.js \
    --players-per-room 8 --rooms-target 20 --rooms-step 1 \
    --step-interval 30000 --syncType state_sync \
    --session-duration 60000
```

观察点(Grafana `Colyseus Battle` dashboard):
- `colyseus_tick_duration_milliseconds` p99 何时跨过红线 16.67ms
- 跨过时 `colyseus_room_count` 是多少 → **房间承载上限**
- battlesvr `nodejs_eventloop_lag_seconds` 何时超过 100ms

### 场景 B: 登陆/结算关键流(完整版)

```sh
cd bots
node dist/scenarios/b_login_battle_end.js \
    --concurrency 100 --duration 300000 --ramp 60000 \
    2> /tmp/stress-b-stderr.log
```

可选 opt-in flag(默认是单次 login + 持续业务循环,符合 Colyseus 官方 loadtest 模式):

- `--relogin-every-cycles N`:每 N 次内循环 relogin 一次,压鉴权链路 / token 刷新。
- `--relogin-every-ms M`:每 M ms relogin 一次。
- `--graceful-stop-ms N`:`duration` 到达后给 in-flight cycle N ms 自然结束(默认 15000)。设 0 则立即 hard abort,样本数完整性下降但 wall-clock 准时;长场景可拉大到 30000。

`relogin-*` 两者互斥。重连退避 `[200,500,1000,2000,5000]` ms;单 op 连续失败 3 次触发熔断重连。

**关停语义**:`duration` 到达后**只是不启新 cycle**,已经在跑的 cycle 自然完成或在 `graceful-stop-ms` 后被强制 abort。Ctrl+C(SIGINT/SIGTERM)立即触发 hard abort,**第二次 Ctrl+C 强退**(exit code 130)。

**Cluster 模式 (concurrency > 500)**:`writeReport` 走 Prometheus instant query 而不是进程内 mirror,详见 §"bot 端指标的准确性边界"。

跑完后粗略看下已知噪声量级(详见 §"已知噪声: bot stderr refId not found"):

```sh
echo "refId not found:        $(grep -c '\"refId\" not found' /tmp/stress-b-stderr.log)"
```

观察点(Grafana `dogsvr Overview` dashboard):
- `dogsvr_cmd_duration_milliseconds{cmdId="ZONE_LOGIN"}` p99 → ZONE_LOGIN 延迟
- `mongo_op_duration_milliseconds{coll="role_coll"}` p99 → Mongo 写延迟
- `redis_op_duration_milliseconds{op="set"}` → Redis 锁获取延迟

### 场景 C: workerThreadNum 扩展曲线

**会自动改 zonesvr 配置 + pm2 restart**,确认这是你想要的:

```sh
bash bots/src/scenarios/c_worker_scaling.sh
```

跑约 4 × (180 + 30) 秒 ≈ 14 分钟。会顺序跑 1/2/4/8 worker 各一档,产出 4 份报告。

跑完后查看:
```sh
ls reports/*-c_worker_scaling_w*/summary.md
# 4 份,grep cycle_qps 提取每档 QPS:
grep -H 'cycle_qps' reports/*-c_worker_scaling_w*/summary.md
```

**关键观察**:`workerThreadNum=N` vs `cycle_qps` 折线,从某档开始 QPS 不再线性增长 → main thread 单线程瓶颈位置。

### 场景 D: 热更新鲁棒性

```sh
bash bots/src/scenarios/d_hot_update.sh
```

跑约 5 分钟,期间 t=120s 时自动 `pm2 trigger exp-zonesvr hotUpdate`。

观察点(Grafana `dogsvr Overview`):
- `dogsvr_txn_timeout_total` 在 t=120s 时是否有尖峰
- `ZONE_LOGIN` 错误率瞬时尖峰高度与持续时长
- `disconnect` 占比(报告中 `fails_disconnect / cycles_total`)

---

## 报告产物

每个场景跑完产出 `reports/<YYYYMMDD-HHMM>-<场景>/`(在 `example-proj-stress` 仓根):

| 文件 | 内容 |
|---|---|
| `summary.md` | 中文摘要,通过/未通过结论 |
| `metrics.json` | bot 端 OTel sync counter snapshot(只 mirror Counter,scenario B cluster 下为空) |
| `system.log` | top + free + uname 快照 |
| `git_revisions.txt` | 各仓库 commit + dirty 标记 |
| `grafana_*.png` | dashboard 截图(浏览器手动截) |

### bot 端指标的准确性边界

bot 进程 metrics 通过 OTLP push 到 4318。SDK 在 `provider.shutdown()` 时
flush pending metrics,进程退出前最后一帧不丢。

**verdict 数据源按场景模式分**:

- **A/C/D 三个 scenario,以及 B 在 ≤ 500 并发下走 in-process**:`summary.md` 的
  cycle 计数 / verdict 来自进程内 `counterMirror`,与 cmd 调用同步累加,
  **不丢**。但 mirror 只覆盖 Counter,Histogram (`bot_cmd_rtt_milliseconds`)
  和 UpDownCounter (`bot_active_count` / `bot_rooms_joined`) 不在内,
  分位和实时活跃度看 Grafana。
- **Scenario B 在 > 500 并发下走 cluster fork**:primary 进程不参与 cmd
  调用,mirror 永远是空。`writeReport` 改查 Prometheus instant query
  (`bots/src/prom_query.ts`),按 `run_id` instrument attribute 隔离
  多次跑(从 `STRESS_RUN_ID` env 读,fork 时由 primary 注入)。primary 在
  `runBotFleet` 返回后 sleep 2s 让 final-flush 落 prom head,再 instant
  query,最多重试 6 次。允许 ±5s 计数尾差(OTLP push interval 5s)。
  Prom 查询失败 → verdict 标为 inconclusive (`passed=false`),
  不 fallback 到空 mirror。

**其他边界**(与传输模式无关):
- Histogram 桶上限 10s,>10s outlier 落 `+Inf`,无法精确还原。
- 多档串跑(场景 C):每档 bot 退出 → counter reset → prom rate=0 断点,
  各档 `summary.md` 不受影响(各自走进程内 mirror)。

---

## Troubleshooting

### 已知噪声: bot stderr `"refId" not found`

**症状**:场景 B(及未来共享 cycle 结构的场景)>= 8 并发时 bot stderr 出现:

```
"refId" not found: <N> { previousRef: _ { ... }, previousRefId: <M> }
Please report this issue to the developers.
```

源头是 `@colyseus/schema/build/index.cjs:4761` 的 `console.error`。同 Node 进程内 ≥2 bot 同 server room 时 decoder 实例间存在跨实例污染(社区 issue 在 0.15 open),server 端字节流是正常的(8 进程 × 1 bot 同 room 时 0 错),真实 Web 玩家(浏览器一进程一 SDK)不踩。

**处理**:跑命令统一 `2> /tmp/stress-<场景>-stderr.log` 把噪声从终端隔离,跑完用 `grep -c` 计数核对。verdict **不计入 refId**:`error_rate` 只看 cycle 整体 throw/不 throw,refId 不抛 → 计入 cycle success(故意如此,压测 server 容量不被 bot 解码 bug 干扰)。

**边界(后续扩展场景务必读)**:
- stderr refId 数量高 ≠ 服务端坏。服务端健康看 `dogsvr_cmd_duration_milliseconds` / `mongo_op_duration_milliseconds` / `dogsvr_txn_timeout_total`。
- bot 端任何依赖 state 解码的断言都不可信。当前 verdict 只看 cycle 成败 + cmd RTT + WS 通断,不读 room state,所以安全。**未来若加 "bot 校验 server state" 类断言**,decoder 漏帧会让断言假阳/假阴,必须改走多进程隔离(`bot_pool.ts` `IN_PROCESS_LIMIT=1` 强制 1 bot 1 进程,代价每 bot ~60-80MB RAM)或不在 bot 侧做 state 断言。
- 不要写代码层 filter(`console.error/warn` monkey-patch 易漏新 SDK 路径,曾尝试已回退)。
- refId 计数若反常上涨(如 100 并发突然涨到原来 10×),触发器画像变了,别忽视。

### Prom 查不到业务 metrics(`dogsvr_*` 全空)

1. `pm2 logs exp-zonesvr` 看启动是否报错(OTLP exporter init / connection refused 会打印)
2. 配置块 `otel.metrics.enabled` 是否为 true:
   ```sh
   grep -A1 'otel' ../example-proj/dist/zonesvr/main_thread_config.json
   ```
3. otel metrics 是否被 import 进 entry: `grep -c otel_metrics ../example-proj/dist/zonesvr/zonesvr.js` 应为 1
4. OTLP HTTP endpoint 通不通:`curl -X POST http://127.0.0.1:4318/v1/metrics` 应返回 415,而不是 ECONNREFUSED
5. Prometheus 是否启用了 OTLP receiver:`ps -ef | grep prometheus | grep -v grep`,启动行应含 `--web.enable-otlp-receiver`

### bot 报 `tsrpc connect failed` / `ECONNREFUSED`

服务没起或 port 错。检查 `pm2 ls`,确认三个 svr 都 online。

### bot 报 `ZONE_LOGIN failed: invalid name`

`stress:fill` 没跑,或 zoneId 不对。`role_coll` 里没有 `openId=stress_*` 记录。

### bot 程序到了 `--duration` 还不结束

预期 = `duration` 之后 ≤ `graceful-stop-ms`(默认 15s)拖尾,让 in-flight cycle 自然完成。stderr 看到 `[Colyseus reconnection]: Re-establishing ...` 说明踩到 SDK 自动重连窗口(`bot_battle.ts` 已加 orphan-room 清理)。Ctrl+C 一次仍不退 → 第二次 Ctrl+C 强退(exit code 130)。

### scenario B verdict=inconclusive(`Prom 查询失败`)

Cluster 模式下 `summary.md` 显示 verdict=inconclusive、`reason` 提到 Prometheus 查询失败 → primary 拿不到 worker 的 cycle 计数。按顺序:

1. 跑期间 prom 是否能查到 cycle:`curl -s 'http://127.0.0.1:9090/api/v1/query?query=sum(bot_cycle_success_total)' | head -c 300`,空 → bot 端 OTLP push 没通,先排 §"Prom 查不到业务 metrics"
2. `run_id` label 是否存在:`curl -s 'http://127.0.0.1:9090/api/v1/series?match\[\]=bot_cycle_success_total' | head -c 500`,应能看到 `run_id="..."`;无 → bot SDK resource attribute 没生效
3. Prom 查询时机太早 — `prom_query.ts` 已在 `runBotFleet` 返回后 sleep 2s + 重试 6×1s,但若 collector pipeline 异常堆积可能要更久;`docker logs otel-lgtm | grep -i drop` 看是否 collector 在丢数据

### Grafana dashboard 全是 "No data"

- prom 是否收到任何 OTLP 数据:`curl 'http://127.0.0.1:9090/api/v1/query?query=dogsvr_cmd_duration_milliseconds_count'`,`status: success` 且 `result` 非空 = 业务侧 push 通的;空 → push 没进来,见上面 "Prom 查不到业务 metrics"
- 验证指标名没有 `_milliseconds` / `_bytes` / `_seconds` 后缀漂移:`curl -s 'http://127.0.0.1:9090/api/v1/label/__name__/values' | grep dogsvr` 应该看到 `dogsvr_cmd_duration_milliseconds_*`,**不应出现** `dogsvr_cmd_duration_ms_*`(老命名)或 `dogsvr_cmd_duration_milliseconds_total_total`(双后缀);若漂移,见 §"Naming" (`observability/README.md`)
- Grafana 数据源 UID 写死为 `prometheus`,如果你手动重建过数据源会变 UID,改 dashboard JSON 或重启 grafana 让 provisioning 复盘
- Tempo / Loki 看不到数据,走下面 "Tempo 里搜不到 trace" / "Loki 里搜不到 log"

### `docker logs otel-lgtm` 报端口冲突 / 容器起不来

通常是 9090 / 3000 / 4318 已被占用 — 排查并杀掉占用进程:

```sh
ss -tlnp | grep -E ':(3000|3100|3200|4317|4318|9090)\b'
docker rm -f otel-lgtm
# (杀掉占用进程后)再重跑启动命令
```

### Tempo 里搜不到 trace

按顺序排查:

1. **OTLP endpoint 通不通** — `curl -X POST http://127.0.0.1:4318/v1/traces` 应返回
   415(POST 没 body),不是 ECONNREFUSED。ECONNREFUSED → 容器没起或 4318 没映射
2. **bot / svr 进程 stderr** — otel SDK export 错误会打印 `OTLPTraceExporter ...`,
   常见 ECONNREFUSED / 400 / 415,看具体错误码
3. **环境变量误覆盖** — `env | grep OTEL_EXPORTER`,如果有自定义 endpoint 把它清掉
4. **collector 内部错误** — `docker logs otel-lgtm | grep -i 'error\|warn'`

### Loki 里搜不到 log

- **central log mode 没启用** — dir 是 inline mode 不发 OTLP logs(预期);
  zonesvr / battlesvr 应走 central 模式,确认 `setupLoggerWithOtel` 已被调用
- **OTLP logs endpoint 通不通** — `curl -X POST http://127.0.0.1:4318/v1/logs` 应返回 415
- 项目策略选 OTel SDK 直调 OTLP logs,不要降级到 `pino-opentelemetry-transport`

### 场景 A 跑完很快,房间数没爬升

- bot session_duration < step_interval → bot 还没跑完就被新 wave 顶下来了。调大 `--session-duration`
- battlesvr 的 Colyseus port 30040 没暴露 → 检查 `pm2 logs exp-battlesvr | grep listen`

### 场景 D 触发后 disconnect 占比异常高

- bot 重连退避策略硬编码 `[200, 500, 1000, 2000, 5000]` ms,共 5 次。如果 hot update 超过 8.7s,所有 bot 都会归类为 disconnect。
- 看 `dogsvr/src/main_thread/server_core.ts` 的 `hotUpdateTimeout`(默认 30s)— 如果业务 worker drain 慢,timeout 会让 disconnect 暴涨

---

## 关闭

```sh
# 观测栈
docker stop otel-lgtm && docker rm otel-lgtm

# 业务进程
cd ../example-proj
pm2 stop ecosystem.config.js
pm2 delete ecosystem.config.js

# 清测试数据(可选,只在准备生产部署或换 zoneId 时)
npm run ops -- stress:unfill --count 10000 --yes
```

Mongo / Redis 不要停(常驻服务)。

---

## 关键开关速查

如果在跑的过程中想临时关掉某类指标 / 信号(节省 CPU 或排除埋点本身的开销):

| 想关闭的指标/信号 | 改哪个文件 / 在哪 | 字段 / 值 | 改后操作 |
|---|---|---|---|
| 全部 dogsvr 框架埋点 | `src/<svr>/main_thread_config.json` | `otel.metrics.enabled = false` | `pm2 restart exp-<svr>` |
| 关闭 trace 信号 | 同上 | `otel.traces.enabled = false` | 同上 |
| 关闭 OTLP logs(改回 inline) | 同上 | `otel.logs.enabled = false` | 同上 |
| 降低 trace 采样率 | 同上 | `otel.traces.samplingRate = 0.01` (1%) | 同上 |
| 仅 mongo timing | `src/<svr>/worker_thread_config.json` | `otel.metrics.mongo.enabled = false` | `pm2 restart exp-<svr>`(worker hot update 也行) |
| 高 QPS 时 mongo 采样 | 同上 | `otel.metrics.mongo.samplingRate = 0.1` | 同上 |
| Colyseus tick 计时 | `src/battlesvr/worker_thread_config.json` | `otel.metrics.colyseus.tickDuration = false` | `pm2 restart exp-battlesvr` |
| 业务侧 OTLP metrics endpoint | 进程环境变量(pm2 ecosystem 的 `env`) | `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=http://...` | `pm2 restart exp-<svr>` |
| 通用 OTLP endpoint(traces / metrics / logs 共用) | 同上 | `OTEL_EXPORTER_OTLP_ENDPOINT=http://...` | 同上 |
| OTLP trace export(进程级旁路) | 同上 | `OTEL_TRACES_EXPORTER=none` | 同上 |
| OTLP logs export(进程级旁路) | 同上 | `OTEL_LOGS_EXPORTER=none` | 同上 |
| bot OTLP metrics endpoint | bot 进程环境变量 | `STRESS_BOTS_OTLP_ENDPOINT=http://...` | 直接 kill bot 重跑 |
| bot run_id(scenario B prom 查询用) | bot 进程环境变量(可省,默认 uuid) | `STRESS_RUN_ID=<id>` | 同上 |
| OTel 全部信号(bot 端) | bot 进程环境变量 | `OTEL_SDK_DISABLED=true` | 同上 |

注意:**dist 下的 JSON 是 build 拷贝过去的**。改 `src/` 后跑 `npm run build` 再 restart;急用直接改 `dist/<svr>/<config>.json` + restart,但下次 build 会被覆盖。

---

## Production Notes(云上简要)

单机优先,云上部署需自行规划。要点:

1. **OTLP backend 不要用 `otel-lgtm` 单容器** — 它是 dev / single-host all-in-one,
   生产 traces / logs 应走托管服务或自建集群:Grafana Cloud / Datadog / Honeycomb /
   腾讯云 APM / 阿里云 ARMS 等。
2. **Prometheus 走托管或 federated**,不要在生产用 9090 直接 scrape 业务节点;
   Kubernetes 上走 Prometheus Operator + ServiceMonitor,或 OTel Collector 中转。
3. **Grafana dashboard 走 IaC** — Terraform / Ansible 把 `observability/dashboards/*.json`
   provisioning 到生产 Grafana,不要手动编辑(避免漂移)。
4. **OTLP endpoint 加 TLS + auth** — 容器 / pod 之间 mTLS,或网关侧 Bearer token,
   通过 `OTEL_EXPORTER_OTLP_HEADERS` 注入(参考 OpenTelemetry SDK 文档)。
5. **采样率** — 生产场景 trace 100% 采样会爆,用 head sampling
   (`OTEL_TRACES_SAMPLER=parentbased_traceidratio` + `OTEL_TRACES_SAMPLER_ARG=0.01`),
   或在 OTel Collector 做 tail sampling(按 latency / error 留样)。
6. **指标命名遵循 OTel 规范**(SDK 不带物理单位后缀 + `unit` 字段;prom OTLP
   receiver 默认 strategy 加 `_milliseconds` / `_total` 等后缀)。详见
   `observability/README.md` §Naming。生产迁移到自建 collector + remote_write
   时无需改命名,dashboard 直接复用。

---

## 参考资料

- dogsvr 框架文档: `../dogsvr/README.md`
- example-proj 集成文档: `../example-proj/README.md`
- observability 子目录: `observability/README.md`
- k6 / ghz 子目录: `k6/README.md` / `ghz/README.md`
