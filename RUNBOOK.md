# Stress 运行手册

单机 Linux 环境下跑 dogsvr-org 压测场景的端到端操作手册。OTLP 三信号
(metrics + traces + logs)backend 用 `grafana/otel-lgtm` 单容器
(LGTMP all-in-one:Loki + Grafana + Tempo + Prometheus + OTel Collector)。
云上部署不在范围,见末尾 [Production Notes](#production-notes云上简要)。

## 约定

- 命令默认在 `example-proj-stress` 仓根执行,先 `cd <polyrepo-root>/example-proj-stress`
- 跨仓引用用 `../<sibling>` 形式(例如 `../example-proj`、`../dogsvr`)
- macOS / Windows Docker Desktop 把下文 `--network=host` 替换为
  `--add-host=host.docker.internal:host-gateway`,并把 `prometheus.yml` 里的
  `127.0.0.1:91xx` 改为 `host.docker.internal:91xx`(本文不展开)

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

# 8. 端口未被占用
#    业务: 9101-9103 main + 9112/9113/9123/9124/9133 worker + 9201 bots
#      (zonesvr/battlesvr 走 central log mode 占 threadId=1,业务 worker 端口比直觉值高 1,
#       详见后文 §Troubleshooting)
#    观测栈: 3000 grafana / 9090 prometheus / 4317 OTLP gRPC / 4318 OTLP HTTP
#            / 3100 loki / 3200 tempo
ss -tln | grep -E ':(3000|3100|3200|4317|4318|9090|9101|9102|9103|9112|9113|9123|9124|9133|9201)\b' \
    && echo "WARN: 有端口已占用"
```

任一失败 → 修后重跑,**不要继续**。

---

## 启动顺序

按依赖关系,**一次跑通的最小路径**:

### 1. 启动 example-proj 三进程

```sh
cd ../example-proj
pm2 start ecosystem.config.js
pm2 ls
```

预期:`exp-dir` `exp-zonesvr` `exp-battlesvr` 三个 online。

### 2. 验证 /metrics 都活着

每个业务进程(主线程 + 各 worker 线程)由 `@opentelemetry/exporter-prometheus`
内置的 HTTP server 暴露一个 `/metrics` endpoint,供后面 Prometheus 容器拉取
(pull-based scrape)。这一步在启动观测栈之前**先 fail-fast 验证业务侧暴露
正常**,把"业务 metrics 注册"和"observability 容器 scrape"两类故障隔开。

端口模型:主线程 9101/9102/9103;worker `portBase + threadId`,其中 `threadId` 是
Node `worker_threads.threadId`,**进程内全局递增**且**不跳过框架内部 Worker**。
具体到本项目:

- dir 走 `log.mode="inline"`,主线程没有内部 Worker,业务 worker threadId = 1,2
  → 9112/9113(portBase=9111)
- zonesvr 走 `log.mode="central"`,`@dogsvr/logger` 在 main_thread 启动时先 fork 一个
  独立的中央日志 Worker(`logger/dist/common/strategies/central_main.js`)占用 threadId=1,
  两个业务 worker 顺延为 threadId=2,3 → **9123/9124**(portBase=9121,**不是** 9122/9123)
- battlesvr 同 central 模式,唯一业务 worker threadId=2 → **9133**(portBase=9131,
  **不是** 9132)

详见 §Troubleshooting "Known issue: central log mode shifts worker /metrics ports"。

```sh
# 主线程
curl -sf http://127.0.0.1:9101/metrics | grep -c '^dogsvr_'   # > 0
curl -sf http://127.0.0.1:9102/metrics | grep -c '^dogsvr_'   # > 0
curl -sf http://127.0.0.1:9103/metrics | grep -c '^dogsvr_'   # > 0

# worker 线程
#   dir 走 inline log mode,业务 worker threadId 从 1 起
curl -sf http://127.0.0.1:9112/metrics | head -3   # dir worker (threadId=1)
curl -sf http://127.0.0.1:9113/metrics | head -3   # dir worker (threadId=2)
#   zonesvr/battlesvr 走 central log mode,中央日志 Worker 占 threadId=1,
#   业务 worker 从 threadId=2 起 → 端口比 portBase+1 高 1。详见 §Troubleshooting。
curl -sf http://127.0.0.1:9123/metrics | head -3   # zonesvr worker (threadId=2)
curl -sf http://127.0.0.1:9124/metrics | head -3   # zonesvr worker (threadId=3)
curl -sf http://127.0.0.1:9133/metrics | head -3   # battlesvr worker (threadId=2)
```

任一 endpoint 返回不了 → `pm2 logs <name>` 看启动错误。

### 3. 启动观测栈(单容器 LGTMP + OTel Collector)

回到 `example-proj-stress` 仓根:

```sh
# 拉起 grafana/otel-lgtm 容器 (LGTMP all-in-one)
#   --network=host: Linux 单机最简,容器可直接 scrape 127.0.0.1:91xx
#   prometheus.yml         : 复用 scrape 配置 (端口模型 1:1 不变)
#   dashboards/            : 3 份 metrics dashboard 的 JSON
#   dashboards-provider.yaml: Grafana provisioning 的 provider 定义
docker run -d --name otel-lgtm \
    --network=host \
    -v $(pwd)/observability/prometheus.yml:/otel-lgtm/prometheus.yaml:ro \
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

# 浏览器打开 (匿名 Viewer 已配置)
#   http://127.0.0.1:9090/targets         所有 7 个 job 应 UP
#   http://127.0.0.1:3000/dashboards      "dogsvr stress" 文件夹 metrics dashboard
#   http://127.0.0.1:3000/explore         切 Tempo / Loki datasource 看 traces / logs
```

Grafana 默认账号 `admin/admin`(只在编辑 dashboard 时需要)。

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
ls reports/
#   应该有一个 <时间戳>-b_login_battle_end/ 目录
cat reports/*-b_login_battle_end/summary.md
```

如果烟雾测试没问题 → 继续大规模。如果报错 → 看下面的 Troubleshooting。

### 场景 A: Colyseus 房间承载上限

```sh
cd bots
node dist/scenarios/a_room_capacity.js \
    --players-per-room 8 --rooms-target 20 --rooms-step 1 \
    --step-interval 30000 --syncType state_sync \
    --session-duration 60000
```

观察点(Grafana `Colyseus Battle` dashboard):
- `colyseus_tick_duration_ms` p99 何时跨过红线 16.67ms
- 跨过时 `colyseus_room_count` 是多少 → **房间承载上限**
- battlesvr `nodejs_eventloop_lag_seconds` 何时超过 100ms

### 场景 B: 登陆/结算关键流(完整版)

```sh
cd bots
node dist/scenarios/b_login_battle_end.js \
    --concurrency 100 --duration 300000 --ramp 60000 \
    2> /tmp/stress-b-stderr.log
```

跑完后粗略看下已知噪声量级(详见 §"已知噪声: bot stderr refId not found"):

```sh
echo "refId not found:        $(grep -c '\"refId\" not found' /tmp/stress-b-stderr.log)"
```

观察点(Grafana `dogsvr Overview` dashboard):
- `dogsvr_cmd_duration_ms{cmdId="ZONE_LOGIN"}` p99 → ZONE_LOGIN 延迟
- `mongo_op_duration_ms{coll="role_coll"}` p99 → Mongo 写延迟
- `redis_op_duration_ms{op="set"}` → Redis 锁获取延迟

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

| 文件 | 内容 | 备注 |
|---|---|---|
| `summary.md` | 中文摘要,通过/未通过结论 | 自动生成,数据源是 bot 进程内 mirror,不依赖 prom |
| `metrics.json` | bot 端 OTel sync counter snapshot | 自动,**只 mirror Counter**,Histogram / UpDownCounter 不在内 |
| `system.log` | top + free + uname 快照 | 自动 |
| `git_revisions.txt` | 各仓库 commit + dirty 标记 | 自动 |
| `grafana_*.png` | dashboard 截图 | 浏览器手动截 |

### bot 端指标的准确性边界

bot 进程的 metrics 走"启 9201 PrometheusExporter,prom 5s 一次 pull-scrape"模式。
该模式对短命进程**有数据漏报**,使用前要清楚两条边界:

**1. 哪些数据是全量准确的:**
- `summary.md` 里的 verdict / QPS / cycle 计数 — 数据来自 bot 进程内
  `counterMirror`(`bots/src/otel_metrics_client.ts:21`),与 cmd 调用同步累加,
  进程退出前才写盘,**不依赖 prom scrape**,不丢。
- `metrics.json` — 同上,但 mirror **只覆盖 Counter** (`bot_cmd_success_total`、
  `bot_cycle_success_total` 等),Histogram (`bot_cmd_rtt_ms`)、UpDownCounter
  (`bot_active_count`、`bot_rooms_joined`) 不在 mirror 里。

**2. 哪些数据可能漏报(都来自 Grafana / Prometheus 侧):**
- **首次 scrape 之前的事件**:bot 启动 → 第一次被 prom scrape ≤ 5s,这窗口
  内的 counter 增量在 server 端 rate() / increase() 起跳延迟。计数本身在进程内
  累加是准的,只是 prom 看到的曲线起点滞后。
- **末次 scrape 之后到进程退出**:`stopBotMetricsEndpoint()` 关 listener 立即,
  最后一次成功 scrape 到进程退出之间的 ≤ 5s 增量**永久丢**。30s 烟雾测试约
  ~16% 数据漏到 server 侧。
- **进程总寿命 < scrape_interval (5s)**:prom 一帧都没拿到,server 侧"这次场景
  没数据"。但 `summary.md` / `metrics.json` 仍然有,因为不走 prom。
- **多档串跑(场景 C)**:每档 bot 退出 → 下一档 bot 启动,counter reset 让
  prom 在 reset 那一秒看到 rate=0,曲线断点。各档自己的 `summary.md` 不受影响。
- **Histogram p99**:`bot_cmd_rtt_ms` 桶边界 `[1,2,5,10,20,50,100,200,500,1000,
  2000,5000,10000]`,outlier 落到 `+Inf` bucket 后无法精确还原延迟值,只知道
  "比 10s 慢"。这是配置选择,不是 bug。

**3. 实务建议:**
- 看延迟 p99 / 分位:用 Grafana 的 `bot_cmd_rtt_ms` panel,**只在 bot 持续运行
  期间看实时图**;事后回看请认知首尾各 ≤ 5s 不可信。
- 看 cycle 总数 / QPS / 错误率:**以 `summary.md` 为准**,Grafana 的同名指标用作
  实时趋势,不要用作结论。
- 短场景 (< 30s):优先用 `summary.md`,prom 数据当作"看个热闹"。
- 想根治 prom 侧的漏头尾:可以把 bot 的 metrics 改成 OTLP push
  (`OTLPMetricExporter` + `PeriodicExportingMetricReader` push 到 4318),
  OTel SDK 在 `provider.shutdown()` 时强制 flush,头尾都不丢。当前未实现。

---

## Troubleshooting

### 已知噪声: bot stderr `"refId" not found`

**症状**:跑场景 B(及未来共享 cycle 结构的场景)>= 8 并发时,bot 进程 stderr 出现:

```
"refId" not found: <N> { previousRef: _ { ... }, previousRefId: <M> }
Please report this issue to the developers.
```

频次随并发上升:8 并发 0 错(cycle 改造后已抑制),100 并发仍稳定出现。
源头是 `@colyseus/schema/build/index.cjs:4761` 的 `console.error`(后续 `Please
report …` 是同一调用紧跟的 `console.warn`,属于同一 decoder 失败,不单独统计)。

**根因边界**(已收窄,详见 plan `0-stress-refid-known-facts.md`):

- `@colyseus/schema` decoder 在**同 Node 进程内 ≥2 bot 同 server room**且
  server 推 state_sync patch(ArraySchema churn)时,decoder 实例之间存在
  跨实例污染,具体共享状态位置尚未定位,社区 issue 0.15 open。
- **server 端 encoder 字节流是正常的**(8 进程 × 1 bot 同 room 时 0 错,
  server 推同样字节流,decoder 不同 → 字节流不是源)。
- bot 端 `room.leave(true)` 路径干净(100 并发场景 B 0 cycle failure)。
- **真实 Web 玩家不踩**:浏览器一进程一 SDK 实例,不在该触发器画像里。

**处理策略**:

1. **stderr 重定向到文件**:跑命令统一加 `2> /tmp/stress-<场景>-stderr.log`
   (见上文每个场景命令),把已知噪声从终端隔离,跑完用 `grep -c` 计数核对。
2. **不计入 verdict**:`error_rate` 只看 cycle 整体 throw/不 throw,refId 不抛
   → 计入 cycle success。这是**故意的**:压测 server 容量(dir/zonesvr/battlesvr/
   mongo/redis 链路)不被 bot 解码 bug 干扰。

**要注意的边界**(后续接手或扩展场景的人务必读):

- **stderr 数量 ≠ 业务错误**:`/tmp/stress-*.log` 里 refId 计数高 ≠ 服务端坏了。
  服务端健康看 dogsvr_cmd_duration_ms / mongo_op_duration_ms /
  dogsvr_txn_timeout_total。
- **bot 端任何依赖 state 解码的断言都不可信**。当前 verdict 只看 cycle 成败、
  cmd RTT、HTTP/WS 通断,不读 room state,所以安全。**未来若加 "bot 校验
  server state(分数 / ball 数 / hp)" 这类断言,decoder 漏帧会让断言假阳/假阴**,
  必须改走多进程隔离(`bot_pool.ts` `IN_PROCESS_LIMIT=1` 强制 1 bot 1 进程,
  代价:每 bot ~60-80MB RAM,100 bot 需 6-8GB)或不在 bot 侧做 state 断言。
- **新场景沿用同样的 stderr 重定向 + grep 计数样板**;不要写代码层 filter
  (`console.error/warn` monkey-patch 易漏新 SDK 路径,曾尝试已回退)。
- **已知 pattern 计数若反常上涨**(比如 100 并发突然涨到原来 10×),说明
  触发器画像变了,回到 plan `0-stress-refid-known-facts.md` 重新收窄,**别忽视**。

### `/metrics` 返回 404 或连接拒绝

1. `pm2 logs exp-zonesvr` 看启动是否报错
2. 配置块 `otel.metrics.enabled` 是否为 true:
   ```sh
   grep -A1 'otel' ../example-proj/dist/zonesvr/main_thread_config.json
   ```
3. otel metrics 是否被 import 进 entry: `grep -c otel_metrics ../example-proj/dist/zonesvr/zonesvr.js` 应为 1
4. 端口冲突 `ss -tln | grep 9102`

### Known issue: central log mode shifts worker /metrics ports

**症状**:`prometheus.yml` 里 zonesvr-worker / battlesvr-worker 的 target 全部 DOWN,但
对应业务进程 pm2 status 是 online、main 进程 /metrics(9102/9103)正常。

**根因**:worker /metrics 端口 = `portBase + node:worker_threads.threadId`(见
`example-proj/src/shared/otel.ts:73`)。`threadId` 在**进程内全局递增**,且
**任何**通过 `new Worker()` 创建的线程都会消耗一个值,**包括框架内部的 Worker**。

`@dogsvr/logger` 在 `mode: "central"` 下会先 `new Worker(central_isolate_entry.js)`
启动一个独立的中央日志 Worker(`logger/dist/common/strategies/central_main.js:52`),
它占走 threadId=1,业务 worker 整体顺延 1 位:

| 进程 | log mode | portBase | 业务 worker threadId | 实际监听 |
|---|---|---|---|---|
| dir | inline | 9111 | 1, 2 | 9112, 9113 |
| zonesvr | **central** | 9121 | **2, 3** | **9123, 9124** |
| battlesvr | **central** | 9131 | **2** | **9133** |

`prometheus.yml` 已按上面的实际监听端口写死,所以**默认是工作的**。如果之后切换 dir 到
central(或反过来),记得同步 `prometheus.yml` 的 target 列表。

**热更新还有第二层副作用**:hot update 不重启进程,新 worker 在同一进程内 `new Worker()`,
threadId 继续递增不回收。`pm2 trigger exp-zonesvr hotUpdate` 后第一次新 worker 拿
threadId=4/5(zonesvr),已经超出 `prometheus.yml` 的 target 列表 → 替换的 worker 永远
scrape 不到。pm2 restart 后新进程 threadId 重新计数才恢复。压测期间不会反复 hot update,
影响 limited;长跑场景下 hot update 越多,死 target 越多。

**当前 workaround**:`prometheus.yml` 写死匹配现状的端口(9123/9124、9133),并接受
hot update 后 worker scrape 暂时失效——见 §"场景 D: 热更新鲁棒性"的预期行为。

**根治方向(尚未实现,按代价从轻到重)**:

1. **业务侧改用业务槽位编号**:`example-proj/src/shared/otel.ts` 把 `portBase + threadId`
   改成 `portBase + workerSlotIndex`。需要 `@dogsvr/dogsvr` 把 main_thread 的
   `createWorker(index)` 槽位 index 通过 `workerData` 传给 worker,并暴露
   `getWorkerIndex()`。pm2 restart / 多次 hot update 都端口稳定。
   但热更新中 rolling 策略"先起新 worker 再 drain 旧 worker"会让两个 worker 抢同一端口
   → 新 worker 的 PrometheusExporter `EADDRINUSE` 没起来,直到下次 pm2 restart 才恢复
   metrics(注意:**不影响业务流量**,因为 PrometheusExporter 的 listen 失败被 SDK 吞掉,
   worker 本身 ready)。
2. **方案 1 + EADDRINUSE 重试**:worker metrics 启动包一层 retry,等旧 worker terminate
   后再 bind。需要框架或业务侧自实现 PrometheusExporter 启动逻辑,放弃 SDK 一行 init 的便利。
3. **接 service discovery**:Prometheus 用 file_sd / http_sd,框架在 worker 启动 / 退出
   时写入 / 移除 target。彻底消除 hot update target 漂移,但要引入 SD 文件管理或 sidecar。

短期内继续走 workaround 即可,以上方案落地前请勿调整文档/scrape config 的端口。

### bot 报 `tsrpc connect failed` / `ECONNREFUSED`

服务没起或 port 错。检查 `pm2 ls`,确认三个 svr 都 online。

### bot 报 `ZONE_LOGIN failed: invalid name`

`stress:fill` 没跑,或 zoneId 不对。`role_coll` 里没有 `openId=stress_*` 记录。

### Grafana dashboard 全是 "No data"

- 看 prom targets 页面,有没有 DOWN 的:`http://127.0.0.1:9090/targets`
- 看 prom 是否能查到指标:`curl 'http://127.0.0.1:9090/api/v1/query?query=dogsvr_cmd_duration_ms_count'`
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
| OTLP trace export(进程级旁路) | 进程环境变量(pm2 ecosystem 的 `env`) | `OTEL_TRACES_EXPORTER=none` | `pm2 restart exp-<svr>` |
| OTLP logs export(进程级旁路) | 同上 | `OTEL_LOGS_EXPORTER=none` | `pm2 restart exp-<svr>` |
| OTel 全部信号(bot 端) | bot 进程环境变量 | `OTEL_SDK_DISABLED=true` | 直接 kill bot 重跑 |

注意:**dist 下的 JSON 是 build 拷贝过去的**,生效顺序:改 `src/`,跑 `npm run build`(其实只需要 copyfiles 步骤),再 restart。或者直接改 `dist/<svr>/<config>.json` 现场改 + restart,但下次 build 会被覆盖。

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

---

## 参考资料

- dogsvr 框架文档: `../dogsvr/README.md`
- example-proj 集成文档: `../example-proj/README.md`
- observability 子目录: `observability/README.md`
- k6 / ghz 子目录: `k6/README.md` / `ghz/README.md`
