# example-proj CPU Profiling 操作手册

## 目录

- [0. 术语与端口速查](#0-术语与端口速查)
- [1. 前置检查](#1-前置检查)
- [2. Continuous profiling —— 开 / 关](#2-continuous-profiling--开--关)
- [3. 在 Grafana 看 flamegraph](#3-在-grafana-看-flamegraph)
- [4. On-demand profiling —— SIGUSR2 抓 30 秒](#4-on-demand-profiling--sigusr2-抓-30-秒)
- [5. 分析 `.cpuprofile`](#5-分析-cpuprofile)
- [6. 压测 + profile 联动流程](#6-压测--profile-联动流程)
- [7. Logger isolate 兜底诊断（`--cpu-prof`）](#7-logger-isolate-兜底诊断--cpu-prof)
- [8. 关闭 / 清理](#8-关闭--清理)
- [9. 附录：文件位置速查](#9-附录文件位置速查)
- [10. 已知观测偏差](#10-已知观测偏差)

## 0. 术语与端口速查

| 项 | 值 |
|---|---|
| Pyroscope 端点 | `http://127.0.0.1:4040` |
| Grafana | `http://127.0.0.1:3000` |
| OTLP HTTP | `:4318`（不本手册相关，仅备注） |
| 采样频率默认 | 10000 µs = **100 Hz**（`samplingIntervalMicros`） |
| On-demand 超时 | **30 s** 自动 stop（`DEFAULT_ON_DEMAND_TIMEOUT_MS`） |
| Dump 目录 | `example-proj/cpuprofile-dumps/`（相对 pm2 cwd） |
| Pyroscope tag | `service_name` / `thread` / `worker_index` |

---

## 1. 前置检查

三条前提都通过再进后续步骤。任一失败先修好，别硬跑。

### 1.1 otel-lgtm 容器已起

```sh
docker ps --format '{{.Names}}\t{{.Status}}' | grep otel-lgtm
```

期望：单行 `otel-lgtm    Up ...`。没起就按 `example-proj-stress/observability/README.md` 的 `docker run` 拉起。

### 1.2 Pyroscope 端口可达

```sh
curl -sf http://127.0.0.1:4040/ready && echo OK
```

期望：`OK`（Pyroscope 内嵌于 otel-lgtm）。返回非零码 = 容器未起或 :4040 被别的进程占。

### 1.3 example-proj 已 build 且 pm2 未跑

```sh
ls /data/dogsvr-org/example-proj/dist/profiling/*.js
pm2 list | grep -E 'exp-(dir|zonesvr|battlesvr)'
```

期望：`dist/profiling/` 下能看到 `profile_main.js` / `profile_worker.js`；pm2 list 里没有旧 `exp-*` 残留（若有旧的、后面第 3 步再 restart 生效）。

---

## 2. Continuous profiling —— 开 / 关

**默认状态**：`battlesvr` main+worker、`zonesvr` main+worker 已在 config 里 `enabled: true`；`dir` main+worker 是 `enabled: false`。**新开机器/首次照本手册时请以 `git diff` 复核**，不要拍脑袋。

### 2.1 想开哪一路，改哪一路

按需要打开对应 svr 的 config：

| svr | main | worker |
|---|---|---|
| `dir` | `src/dir/main_thread_config.json` → `profiling.enabled` | `src/dir/worker_thread_config.json` → `profiling.enabled` |
| `zonesvr` | `src/zonesvr/main_thread_config.json` | `src/zonesvr/worker_thread_config.json` |
| `battlesvr` | `src/battlesvr/main_thread_config.json` | `src/battlesvr/worker_thread_config.json` |

**只开 continuous 不需要重 build**（config 是 JSON、运行时读）。只需 pm2 重启对应 svr：

```sh
cd /data/dogsvr-org/example-proj
pm2 restart exp-battlesvr        # 例：只开 battlesvr
```

如果 pm2 里还没起，`npm run start` 拉起全部：

```sh
cd /data/dogsvr-org/example-proj
npm run start                    # 需用户许可 —— pm2 拉起 dir/zonesvr/battlesvr
```

### 2.2 采样频率与端点覆写

- 频率：改 `samplingIntervalMicros`。**生产/长时段压测可调到 20000（50 Hz）** 减半开销；短时段诊断保持 10000。
- 端点：`profiling.endpoint` 优先；未填时读 env `PYROSCOPE_SERVER_ADDRESS`；再无则 `http://127.0.0.1:4040`。远端 Pyroscope 通过 env 覆盖：
  ```sh
  PYROSCOPE_SERVER_ADDRESS=http://pyroscope.internal:4040 pm2 restart exp-battlesvr --update-env
  ```
  注意 `--update-env`，否则 pm2 沿用旧 env。

### 2.3 关掉 continuous

```sh
# 单 svr
sed -i 's/"enabled": true/"enabled": false/' \
  src/battlesvr/main_thread_config.json src/battlesvr/worker_thread_config.json
pm2 restart exp-battlesvr
```

或直接 `pm2 stop <name>`。**关掉 continuous 不影响 on-demand**（on-demand 走 SIGUSR2 独立通道，第 4 节）。

---

## 3. 在 Grafana 看 flamegraph

打开 `http://127.0.0.1:3000` → 左侧 Dashboards → folder **dogsvr stress** → `profile_flamegraph`。

### 3.1 dashboard 变量

顶栏：

- **`$svr`** —— `dir` / `zonesvr` / `battlesvr`。切换即换 flame。
- **`$worker_index`** —— `0` / `1` / ...；只影响 "per-worker breakdown" 那格。

### 3.2 panel 一览

| Panel | 覆盖 | 何时看 |
|---|---|---|
| Flame graph — main thread | `{service_name=$svr, thread=main}` | 主线程热点：request 分发、GC、native |
| Flame graph — worker threads (aggregate) | `{service_name=$svr, thread=worker}` | 所有 worker 汇总 |
| Flame graph — per-worker breakdown | `{service_name=$svr, thread=worker, worker_index=$worker_index}` | 单 worker 定位（例：某 worker 独占 CPU） |
| Diff flame | 前半段 vs 后半段（时间范围决定） | 压测前后对比、上线前后回归 |

### 3.3 常用查询窍门

- **时间范围**：默认右上角 "Last 5 min" 足以看当下热点；对比前后各取 5 min → 时间选 10 min 后 Diff panel 自动切分。
- **Left Heavy 视图**：Grafana flame 面板右上角 "View" 里切换。定位单一热函数比 Time Order 更快。
- **在 Explore 里手写 label filter**：Explore → datasource 选 Pyroscope → `{service_name="battlesvr", thread="worker", worker_index="0"}`。tag key 用**下划线**（`service_name` 不是 `service.name`），Pyroscope 不接受点号。

### 3.4 dashboard 没数据的排查

按下列顺序排：

1. 对应 svr 的 `profiling.enabled` 是不是 `true`？（第 2 节）
2. 该 svr pm2 是不是那次改 config **之后** restart 过？未 restart = 老进程仍旧读旧 config。
3. `curl http://127.0.0.1:4040/api/apps` 是不是能看到 `example-proj`？看不到 = SDK 未上报，检查进程日志里有没有 `@pyroscope/nodejs` 报错。
4. Pyroscope 首批上报延迟约 10 s；进程刚起立刻看会空。

---

## 4. On-demand profiling —— SIGUSR2 抓 30 秒

### 4.1 触发原理（一句话）

`pm2 sendSignal SIGUSR2 <app>` → 打到 pm2 fork 的主 Node 进程 → main 用 `inspector` 开 profile，同时通过 `dogsvr.broadcastToWorkers` 广播给所有 worker → worker 各自 `inspector` 开采 → 30 s 后（或再一次 SIGUSR2）各自 stop 并写 `.cpuprofile` 到 `example-proj/cpuprofile-dumps/`。

**关键点**：worker thread 不是 OS 进程、没独立 pid，**不**响应 kill/SIGUSR2；必须走 dogsvr broadcast，别想着 `kill -USR2 <tid>`。

### 4.2 标准 15 秒采样流程

```sh
cd /data/dogsvr-org/example-proj

# 记录当前 dump 目录内容
ls cpuprofile-dumps/ 2>/dev/null | wc -l    # 之前有几个文件

# 触发 start
pm2 sendSignal SIGUSR2 exp-battlesvr

# 等 15 秒
sleep 15

# 触发 stop（也可以等 30s 自动超时）
pm2 sendSignal SIGUSR2 exp-battlesvr

# 检查产物：main 1 个 + 每个 worker 1 个
ls -lh cpuprofile-dumps/
```

**期望产物**（battlesvr，1 个 worker）：

```
battlesvr-<pid>-main-2026-07-18T09-20-11-123Z.cpuprofile
battlesvr-<pid>-worker-0-2026-07-18T09-20-11-123Z.cpuprofile
```

zonesvr / dir 各有 2 个 worker，会多出 `worker-1` 那一份。

### 4.3 30 秒自动超时

如果第二次 SIGUSR2 忘发，30 s 后每个线程会自己 stop 并落盘。放心，不会一直采下去。

### 4.4 同一进程多次触发

同一进程连着抓多次没问题，文件名带 ISO8601 时间戳不会覆盖。**但**：正在 profiling 中的进程收到第二次 SIGUSR2 会被视为 "stop"，第三次才是新的 "start"。想稳，就"SIGUSR2 → 等落盘 → SIGUSR2"两两配对。

### 4.5 只想抓 main、不想动 worker？

现有实现是 main 收到 SIGUSR2 就 broadcast，无法只抓 main。**权宜方案**：抓完后把 worker 的 `.cpuprofile` 删掉、只看 main 的。若强需求 "只抓一路"，走代码改造，不属日常操作。

### 4.6 触发后没产物 —— 排障

| 现象 | 常见原因 | 排查 |
|---|---|---|
| `cpuprofile-dumps/` 目录都没建 | pm2 cwd 与预期不同 | `pm2 info exp-battlesvr` 看 `exec cwd`；应为 `/data/dogsvr-org/example-proj` |
| 只有 main 的 `.cpuprofile`,worker 缺 | broadcast 未生效 | 看 pm2 log 有无 `broadcast handler` 相关报错；确认 `@dogsvr/dogsvr` 版本已含 `broadcastToWorkers`（`cd example-proj && npm run linkDog`）|
| 完全无产物 | SIGUSR2 未送到 | `pm2 list` 确认 app name 拼写；宿主 shell 若有 signal 拦截，直接 `kill -USR2 <pid>` |
| 文件很大（几十 MB）却打不开 | 采样时段过长（超 60 s）| 减少 profiling 时长；30 s 是官方推荐上限 |

---

## 5. 分析 `.cpuprofile`

### 5.1 首选：Speedscope（浏览器，纯前端）

```sh
cd /data/dogsvr-org/example-proj
npx speedscope cpuprofile-dumps/battlesvr-*.cpuprofile
```

首次会拉包（几十 MB）。之后本地缓存。默认打开 Time Order 视图；**多数场景切 Left Heavy** —— 按函数聚合后从左到右倒序，热点一眼可见。

多个文件想同时对比：一次拖多个进浏览器 tab；Speedscope 支持 tab 切换 side-by-side。

### 5.2 备选：Chrome DevTools

Chrome → DevTools → Performance panel → 右上角齿轮/菜单 → "Load profile" → 选 `.cpuprofile`。看**火焰图/自顶向下**都行。Firefox Profiler 也吃这个格式。

### 5.3 常见热点定位路径

| svr / thread | 期望 top 热点（正常） | 异常信号 |
|---|---|---|
| `battlesvr` worker | `matter-js Engine.update`、`Colyseus Room#patch`、`Schema encode` | `sonic-boom` 类栈占比 >5% = 日志过量 |
| `zonesvr` worker | `MongoDB find` / `@redis/client`、`tsrpc handler` | `JSON.parse` >10% = 请求体过大或反序列化配置错 |
| `dir` main | 少量 tsrpc HTTP 路由 | main 长时间 >30% CPU = 应该分派到 worker 的活跑在 main |

---

## 6. 压测 + profile 联动流程

用于 "看压测前后热点差异"。

```sh
# 1. baseline：空跑
cd /data/dogsvr-org/example-proj
pm2 start ecosystem.config.js                                   # 需用户许可
# 等 60 s 让 Pyroscope 收到 baseline

# 2. 起 bots 压测
cd /data/dogsvr-org/example-proj-stress/bots
npm run build && node dist/main.js <scenario>                   # 需用户许可

# 3. Grafana 里选 Diff flame panel，时间范围覆盖 "空跑 + 压测" 两段
#    Diff panel 会自动以时间中点切两段做 baseline vs current
```

期望差异：battlesvr worker 的 `matter-js` / `Colyseus patch` 栈显著变高；zonesvr worker 的 `MongoDB find` / Redis 栈显著变高。若某段 CPU 涨了但 flame 没差异 —— 检查 `profiling.enabled` 是不是压测前后都开着（关着的时段 flame 不涨才怪）。

---

## 7. Logger isolate 兜底诊断（`--cpu-prof`）

**仅当怀疑 zonesvr/battlesvr 的 logger central isolate 吃 CPU 时使用。** 日常不用碰。

改 `ecosystem.config.js` 对应条目加 `node_args`：

```js
{
    ...base,
    name: 'exp-battlesvr',
    script: path.join('dist', 'battlesvr', 'battlesvr.js'),
    node_args: ['--cpu-prof', '--cpu-prof-dir=/tmp/prof-logger',
                '--cpu-prof-name=logger-{pid}.cpuprofile'],
}
```

`--cpu-prof` 会让**所有** worker_thread（包含 logger isolate）在进程退出时落盘。因此流程是：

```sh
pm2 start ecosystem.config.js       # 需用户许可,启动即开始采样
# ... 复现问题 ...
pm2 stop exp-battlesvr              # 停 = flush 到 /tmp/prof-logger/
ls /tmp/prof-logger/
```

用完**记得把 `node_args` 删掉**，别提交进 git。

---

## 8. 关闭 / 清理

```sh
# 1. 关 continuous
sed -i 's/"enabled": true/"enabled": false/' \
    /data/dogsvr-org/example-proj/src/*/main_thread_config.json \
    /data/dogsvr-org/example-proj/src/*/worker_thread_config.json
pm2 restart all                     # 需用户许可

# 2. 清 on-demand dump
rm -rf /data/dogsvr-org/example-proj/cpuprofile-dumps/*

# 3. 若要停 otel-lgtm（会顺带丢掉 Pyroscope 数据）
docker stop otel-lgtm && docker rm otel-lgtm    # 需用户许可
```

**关于 Pyroscope 数据保留**：otel-lgtm 单容器**未挂 volume**，重启即丢历史 profile。若需长期保留，走独立 Pyroscope OSS 部署（超出本手册范围）。

---

## 9. 附录：文件位置速查

| 用途 | 路径 |
|---|---|
| profile 装配（main） | `example-proj/src/profiling/profile_main.ts` |
| profile 装配（worker） | `example-proj/src/profiling/profile_worker.ts` |
| profile 默认常量 | `example-proj/src/profiling/defaults.ts` |
| profile 配置类型 | `example-proj/src/profiling/config.ts` |
| dir 配置 | `example-proj/src/dir/{main,worker}_thread_config.json` |
| zonesvr 配置 | `example-proj/src/zonesvr/{main,worker}_thread_config.json` |
| battlesvr 配置 | `example-proj/src/battlesvr/{main,worker}_thread_config.json` |
| on-demand dump 输出 | `example-proj/cpuprofile-dumps/` |
| Grafana dashboard | `example-proj-stress/observability/dashboards/profile_flamegraph.json` |
| dogsvr broadcast API | `dogsvr/src/main_thread/index.ts` (`broadcastToWorkers`) |
| dogsvr worker broadcast 接收 | `dogsvr/src/worker_thread/index.ts` (`onWorkerBroadcast`) |
| pm2 编排 | `example-proj/ecosystem.config.js` |

---

## 10. 已知观测偏差

开启 profiling（continuous 或 on-demand）后，**worker/main 的 `dogsvr_worker_elu_utilization` / event loop utilization 会被人为拉高**，与真实 CPU 占用严重不符。典型症状：worker ELU 稳定在 30~50% 但 `top` / `pidstat` 看到的 %CPU 只有几个百分点。

### 10.1 机制

1. `@pyroscope/nodejs` 的 wall profiler = `@datadog/pprof` `TimeProfiler` = V8 `CpuProfiler`。Linux 下 V8 通过独立 sampler 线程 `pthread_kill(target_tid, SIGPROF)` 触发采样，被采线程在自己的 signal handler 里做 stack unwind。100 Hz 采样 = 每秒 100 次 SIGPROF 打到 worker 主线程。
2. SIGPROF 让 `epoll_pwait` 返回 `EINTR`。libuv `uv__io_poll` 的 EINTR 分支**跳过** `uv__metrics_update_idle_time`、重进循环时又 `uv__metrics_set_provider_entry_time` **覆盖** `provider_entry_time`——被打断前累积的那段 `sleep` 时间既没归入 idle，也不算 active，从统计里蒸发。
3. `performance.eventLoopUtilization().utilization = active / (active + idle)`，分母是**墙钟时间**。idle 缩水 → utilization 抬升；SIGPROF handler 本身很轻（<100 µs/次，100 Hz 累积 <1% CPU），所以 `%CPU` 几乎无变化。

### 10.2 量级参考

以 worker "本来 idle 主导（900 ms/s epoll_pwait + 100 ms/s 业务）" 为例：

| 采样频率 | 每次 SIGPROF 丢失的 idle | ELU 表观值 | 真实 CPU |
|---|---|---|---|
| 关闭 | — | ~10% | ~10% |
| 100 Hz（默认） | ~5 ms | **20~50%** | ~10.5% |
| 200 Hz | ~5 ms | **40~70%** | ~11% |

**结论**：开着 profiling 时 ELU 不能作为容量告警依据；`%CPU` 才是可信参照。

### 10.3 应对

按 profiling 模式分开处理。

**Continuous 常开（zonesvr/battlesvr 默认）**：ELU 长期偏高，"短暂屏蔽"无意义。

- **首选**：告警口径改用 `dogsvr_worker_eventloop_lag_seconds`（event loop delay 均值）。它反映"事件循环单圈被阻塞多久"，与 SIGPROF signal handler 时长无关，不受采样影响。
- **次选**：把 profiling 服务的 `dogsvr_worker_elu_utilization` 从告警规则里 filter 掉，仅供人工观察。

**On-demand（SIGUSR2 30 s 窗口）**：真正意义上的"短暂屏蔽"。

在 `example-proj/src/otel/metrics_worker.ts` 的 ELU callback 里，profiling 期间跳过 `r.observe()`（`prevElu` 仍要推进，避免 profiling 段偏差污染下一窗口）：

```ts
.addCallback((r) => {
    const now = performance.eventLoopUtilization(prevElu);
    prevElu = performance.eventLoopUtilization();
    if (isProfilingActive()) return;   // ← profile_worker.ts 导出该状态
    r.observe(now.utilization, attrs);
});
```

代价：ELU 曲线在 profiling 段有 30 s gap。告警规则通常按 `absent_over_time` 处理为 unknown，不会误报。

**降低偏差量级（通用）**：把 `samplingIntervalMicros` 从 `10000`（100 Hz）调到 `20000`（50 Hz），SIGPROF 频率减半，ELU 偏差也大致减半，代价是 flame 采样密度下降。生产长时段可选。

### 10.4 相关代码位置

| 用途 | 路径 |
|---|---|
| ELU gauge 定义 | `example-proj/src/otel/metrics_worker.ts:258` |
| Event loop delay gauge | `example-proj/src/otel/metrics_worker.ts:269` |
| Profiling 状态（可导出） | `example-proj/src/profiling/profile_worker.ts` |
| 采样频率配置 | `example-proj/src/*/worker_thread_config.json` → `profiling.samplingIntervalMicros` |

### 10.5 顺带一提：Pyroscope shutdown

`Pyroscope.stop()` 内部走 undici `fetch` 上传最后一批 profile，无 request timeout。若 4040 不可达，可能挂到内核 TCP 重试超时（>60 s），把 dogsvr 的 `onShutdown drain` 拖长。`profile_main.ts:48` / `profile_worker.ts:53` 已用 `Promise.race + setTimeout(2000).unref()` 包住；pm2 `kill_timeout` 保持默认 1600 ms 时仍可能被硬杀，但不会 leak。

---

**文档版本**：v1（2026-07-18）
