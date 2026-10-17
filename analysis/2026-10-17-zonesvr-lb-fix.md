# zonesvr leastLoad 修复与 2026-10 性能复测

_2026-10-17 · 续 [2026-07-26 zonesvr 容量分析](2026-07-26-zonesvr-capacity.md) §5.5 / §5.7 · 场景 F 共 6 次压测（轮询 ×2、leastLoad ×2、leastLoad + postMessage ×2）· Prometheus + Pyroscope + /proc 线程 CPU_

> **原始数据会过期**：07-26 的 Prometheus / Pyroscope 数据在 10-17 已经查不到，`reports/` 目录也被 `.gitignore` 排除、只存在于压测机本地。本文表格就是存档——附录 A 是每次运行的全部 Prometheus 数值，附录 B 是 Pyroscope 分类拆解，附录 C 是查询方法与脚本 [`scripts/zonesvr_run_stats.py`](scripts/zonesvr_run_stats.py)。后续复测用同一个脚本、按同样口径（§2.3）对比即可。

## 〇、范围

**本次 lb fix 包含的改动**（dogsvr，基于 `2011adb`，撰写时尚未提交），详见 §四：

1. 默认负载均衡策略从 `roundRobin`（轮询）改为 `leastLoad`
2. `LeastLoadLB` 计数并列时轮转，选择改为单遍扫描
3. 热更新后，旧 worker 的 txn 超时不再减新 worker 的计数
4. worker 的 SAB 消息通道改为 `initFn` 完成后才开始消费

**SAB 的优化已单独完成，不在本次 lb fix 内。** 07-26 原文 §5.7.5 列出的 SAB 实现优化（定长二进制 head、去掉 `resetIndexes`、批量 drain、head + body 合并写、notify 消除）由以下提交在 2026-09 ~ 10 单独完成：

| 仓库 | 提交 | 日期 | 说明 |
|---|---|---|---|
| dogsvr | `160e07b` | 2026-09-12 | refine SAB implementation |
| dogsvr | `3f4bbc3` | 2026-09-13 | review sab implementation |
| dogsvr | `2011adb` | 2026-10-11 | fix: prevent SAB lost wakeups and reject invalid buffer sizes |
| logger | `e8b621d` | 2026-09-12 | refine SAB implementation（日志通道） |

设计说明见 `dogsvr/docs/explanation/sab_ring_design.md` 与 `sab_transport_layers.md`。本文 §七 的 SAB vs postMessage 对照，是对这批**已有优化的验收复测**，不是本次 lb fix 的效果。lb fix 第 4 条虽然改在 SAB 通道的启动顺序上，但它是初始化期间的正确性修复（防止 leastLoad 把请求导向未初始化完的 worker），不是性能优化，稳态压测中不产生可测差异。

## 一、结论

| 主题 | 结论 | 关键数字 | 依据 |
|---|---|---|---|
| 负载不均（§三~§五） | 成因是闭环压测 + 轮询下的对称破缺；改用 leastLoad 后消除 | 两侧在途 15 / 874 → 约 440 / 440；QPS +6.2 %；平均耗时 −6.4 % | 轮询 ×2 vs leastLoad ×2，同一会话 |
| CPU 上涨（§六） | 由吞吐上升带来，每次请求的 CPU 反而下降 | 进程 3.28 → 3.40 核（+3.4 %）；每次 rank 查询 992 → 966 µs（−2.6 %） | /proc 线程 CPU |
| SAB vs postMessage（§七） | 07-26 §5.7 的问题已由 2026-09 的 SAB 优化解决：SAB 在吞吐、CPU、耗时上都胜出 | QPS +2.5 %；每次请求 CPU −3.5 %；平均耗时 −1.8 % | leastLoad + SAB ×2 vs leastLoad + postMessage ×2 |
| 整体（§八） | 相对 07-26 run2 有提升 | QPS 3075 → 3513（+14.2 %）；每次请求 main + worker CPU 800 → 746 µs（−6.8 %）；bot p99 979 → 496 ms | 跨日期对比；其中 +7.6 % 那一段含环境漂移，无法剥离 |
| 测量方法（§7.4） | Pyroscope 整段 profile 总量有约 ±10 % 噪声，不能用来比较 CPU 绝对值 | 同配置两次：984 vs 897 s、1031 vs 926 s；/proc 只差 0.7~1.5 % | 07-26 原文"SAB 进程 CPU +10 %"落在这个噪声内 |

**07-26 原文需更正的推论**：

1. "leastLoad 必须配 worker 2→4 才安全"不成立，2 个 worker 直接换就有 +6 %（§五）。
2. "修复后 p99 回到约 36 ms、mongo p99 回到约 10 ms"不成立：闭环下平均耗时 = 在途数 / 吞吐，由 bot 数决定（§5.3）。
3. "放慢 ramp 可减少触发"不成立（§三）。
4. "约 850 是深队列平衡点"：它只是在线 bot 数减去浅侧的在途数（§三）。
5. §5.7"SAB 进程 wall:cpu 反而 +10 %"是测量噪声（§7.4）。
6. §2.2 / §九 把 `:Non JS threads activity:` 说成"libuv thread pool + V8 后台 + …"：实测主体是 4 个 V8Worker 线程，libuv 线程几乎不占 CPU（§6.2）。

## 二、测试环境与方法

### 2.1 环境与代码版本

- 主机与 07-26 是同一台：32 vCPU、62 GiB 内存的 Linux 6.6（x86-64）虚拟机，Node v24.13.0。被压侧（dogsvr）与压侧（bot、otel-lgtm、Redis、MongoDB）同机，数值只作相对参考。
- 代码版本（07-26 一列按提交时间推断）：

| 仓库 | 07-26 run1 / run2 | 2026-10-17 |
|---|---|---|
| dogsvr | `32e70c5`（07-25） | `2011adb` + 本次 lb fix |
| logger | `75b3c03`（07-19） | `e8b621d` |
| example-proj | `25c77af` | `25c77af` |
| cl-tsrpc | `8051770` | `8051770` |
| example-proj-stress `bots/` | `b23a750` | `b23a750`（之后的提交只改文档和 dashboard，压测客户端没变） |

- 6 次运行相同的 zonesvr 配置：`workerThreadNum: 2`；`log.level: trace`（main 和 worker），`log.mode: central`；OTel metrics 开（`sampleIntervalMs: 1000`，`samplingRate: 1.0`，threadStats 开；worker 侧 mongo / redis 计时采样 1.0，heap / ELU / GC / cmdHdl 开）；traces、logs 导出关；Pyroscope 开（`samplingIntervalMicros: 10000`）。
- 变化的只有两项：`lbStrategy`，以及 msg 通道 `channel.msg.transport` 和日志通道 `log.channel.transport`（两者同时切换）。postMessage 两次用的是 example-proj git HEAD 中的通道配置，与 07-26 run1 相同。

### 2.2 压测参数与 6 次运行

命令（其余参数取默认：在线 60~180 s、离线 5~30 s、心跳 30 s、rank-id 1、rank-count 100）：

```
node dist/scenarios/f_realistic_session.js --concurrency 1000 --duration 300000 --ramp 60000 --weight-battle 0 --weight-rank 3
```

每次运行前执行 `pm2 restart exp-dir exp-zonesvr exp-battlesvr` 并等待 15 s。

| 简称 | LB | msg / log 通道 | `STRESS_RUN_ID` | 报告目录 `reports/…` | 开始 / 结束（UTC） | 错误率 |
|---|---|---|---|---|---|---:|
| 轮询 #1 | roundRobin | sab / sab | `lb-rr-1` | `2026-10-17T10-56-f_realistic_session` | 10:56:26.621 / 11:01:44.173 | 0.00 % |
| 轮询 #2 | roundRobin | sab / sab | `lb-rr-2` | `2026-10-17T11-03-f_realistic_session` | 11:03:20.568 / 11:08:37.990 | 0.00 % |
| leastLoad #1 | leastLoad | sab / sab | `lb-ll-1` | `2026-10-17T11-10-f_realistic_session` | 11:10:15.985 / 11:15:33.431 | 0.00 % |
| leastLoad #2 | leastLoad | sab / sab | `lb-ll-2` | `2026-10-17T11-17-f_realistic_session` | 11:17:12.961 / 11:22:30.373 | 0.00 % |
| postMessage #1 | leastLoad | postMessage / postMessage | `lb-pm-1` | `2026-10-17T12-12-f_realistic_session` | 12:12:05.065 / 12:17:22.481 | 0.00 % |
| postMessage #2 | leastLoad | postMessage / postMessage | `lb-pm-2` | `2026-10-17T12-18-f_realistic_session` | 12:18:12.694 / 12:23:30.089 | 0.00 % |

### 2.3 观测窗口与口径

- **Prometheus 窗口**：开始后 60~300 s（ramp 结束到 bot 停止），即在开始 + 300 s 时刻取 `[4m]`。
- **Pyroscope 窗口**：开始后 75~300 s，只用来算各函数的占比。
- **"每次请求" / "每次查询"**：一律除以 cmd 20004（`ZONE_QUERY_RANK_LIST`）的 QPS。其他 cmd（心跳、登录）约占 1 %，各次运行一致。
- **线程 CPU**：`dogsvr_thread_cpu_utilization`，由 dogsvr 主线程读 `/proc/<pid>/task/<tid>/schedstat` 得到，按 `thread_role` 分为 main / worker / internal / logger_central。internal 在本场景下基本就是 V8Worker（§6.2）。
- **Pyroscope 分类换算成每次请求**：`类别 µs/查询 = 该类别 self 耗时 ÷ 该线程 profile 总量（main 去掉 Non JS 桶）× 该线程 /proc CPU 核数 ÷ QPS × 10^6`。profile 只提供比例，绝对值来自 /proc，原因见 §7.4。
- **直方图精度**：桶边界为 0.5、1、2、5、10、20、50、100、200、500、1000、2000 … ms，`histogram_quantile` 只能精确到桶，所以分位数写所在桶（附录 A 列出插值结果仅供参考）；平均值由 sum / count 算出，是精确值。
- **event loop lag**：`dogsvr_worker_eventloop_lag_seconds` 是 `monitorEventLoopDelay({ resolution: 10 })` 在每个上报周期内的均值，含约 10 ms 的分辨率基线（空闲的 dir worker 读数为 0.010 s）。超出基线的部分 = 读数 − 0.010 s。
- **噪声（同配置两次运行之差）**：QPS ≤ 0.7 %，每次请求 CPU ≤ 1.6 %。小于这个量级的差异不下结论。

## 三、分裂机制

- 设 μ(q) 为一个 worker 手上有 q 个在途请求时每秒的完成数。q 小时随 q 上升（并发越多，越能把等 mongo / redis 的时间重叠起来），CPU 打满后封顶，再往上缓慢下降（在途对象多 → 堆大 → GC 多）。
- 场景 F 是闭环：bot 收到响应立刻发下一个请求（`bots/src/bot_fleet.ts` 内循环，场景 F 不配 jitter），所以两侧在途数之和固定 ≈ 在线 bot 数（concurrency 1000 时约 880）。
- 轮询把完成数对半派回两侧，于是 w1 在途数的变化率 = `(μ(q0) − μ(q1)) / 2`。

| 平衡点 | 稳定性 | 原因 |
|---|---|---|
| 两侧各约 440 | 不稳定 | 两侧都在"越多越慢"段。w1 多拿一个 → w1 变慢、w0 变快 → 新请求仍对半分 → w1 越积越多 |
| w0 约 15 / w1 约 875 | 稳定 | w0 只有十几个在途，喂不饱 CPU（ELU 0.95），处在上升段。少一个就明显变慢，派给 w1 的随之减少，形成回拉 |
| 镜像（w0 深 / w1 浅） | 稳定 | 同上 |

两个稳定点中间隔一个不稳定点，是严格意义的双稳态；07-26 原文对"双稳态"的判断对，但把两个稳态描述成了"两侧都浅 / 一侧深"。三个条件缺一个，分裂就消失：

| 条件 | 去掉后 |
|---|---|
| 闭环（在途总数固定） | 开环且总负载低于容量时两侧都会排空；开环接近容量时，深的一侧会持续增长到 txn 超时，不会停在某个值 |
| 轮询（不看负载） | JSQ（join-shortest-queue，每次派给在途数最少的 worker）把新请求派给在途少的一侧，直接抵消正反馈，两侧相等的状态变成稳定的 |
| μ 随 q 增大而下降（GC） | 两侧在途差只会随机漂移，不会自己锁死 |

07-26 run1 / run2 和本次两次轮询，**4 次都是 w1 卡住**。说明有一个微小的系统性偏向决定了落到哪一侧，不是纯随机；来源没有定位（候选：`RoundRobinLB` 的首个请求派给 w1，使 w1 的累计派发数总是 ≥ w0；线程调度）。

## 四、lb fix 改动（dogsvr）

| 位置 | 改动 |
|---|---|
| `src/main_thread/server_core.ts` | `lbStrategy` 默认值 `roundRobin` → `leastLoad` |
| `src/main_thread/lb.ts` `LeastLoadLB` | 单遍扫描；扫描起点放在上次选中位置之后，计数并列时轮转（原实现并列时永远选 w0，低负载时 w1 一直是冷的） |
| `src/main_thread/index.ts` 超时回调 | 只在该槽位还是同一个 worker 时才减计数。原实现在热更新后，会把旧 worker 的超时减到新 worker 头上 |
| `src/worker_thread/index.ts` | SAB 通道改在 `initFn` 完成后才开始消费，与 postMessage 路径一致。原实现中，新 worker 在初始化期间访问未初始化的 redis / mongo client 会立刻回错，在途计数涨不上去，leastLoad 会把热更新期间几乎全部请求导向它 |
| `test/lb.test.ts`（新增） | 并列轮转、选最少、部分并列、计数下限、`resetIndex`、factory 各分支 |
| 文档 | `config_templates/main_thread_config.template.json`、`README.md`、`.claude/FRAMEWORK_REFERENCE.md` 的默认值说明 |

leastLoad 的信号是主线程侧的在途 txn 数（已派出、尚未回包），覆盖"通道 → worker 排队 → 等 I/O → 回包"整条链路，实时、精确，不需要额外的跨线程通信。worker 上报的 ELU / event loop lag 按秒级采样，信号滞后，容易让请求一起涌向同一个 worker，不适合做派发依据。

验证：`dogsvr` `npm test` 9 个用例全部通过；`example-proj` `npm run build` 通过。第 4 条（热更新期间）只做了代码审查，没有跑 `d_hot_update`。

## 五、leastLoad vs 轮询 A/B

两组都是 SAB 通道。每次运行的完整数值见附录 A。

| 指标 | 轮询 #1 | 轮询 #2 | leastLoad #1 | leastLoad #2 |
|---|---:|---:|---:|---:|
| cmd 20004 QPS | 3320 | 3297 | 3512 | 3514 |
| cmd 平均耗时 | 267 ms | 268 ms | 251 ms | 250 ms |
| cmd p99 所在桶 | (500, 1000] | (500, 1000] | (200, 500] | (200, 500] |
| bot RTT p50 / p99 | 38 / 981 ms | 41 / 979 ms | 294 / 496 ms | 280 / 496 ms |
| `worker_cmd_hdl_pending` 均值 w0 / w1 | 14 / 875 | 16 / 873 | 440 / 440 | 443 / 442 |
| `worker_cmd_hdl` 平均耗时 w0 / w1 | 8 / 507 ms | 9 / 509 ms | 233 / 229 ms | 231 / 231 ms |
| 处理速率 w0 / w1（/s） | 1660 / 1661 | 1648 / 1649 | 1742 / 1770 | 1755 / 1759 |
| ELU w0 / w1 | 0.95 / 1.00 | 0.96 / 1.00 | 1.00 / 1.00 | 1.00 / 1.00 |
| worker 线程 CPU（两个 tid） | 0.947 / 0.989 | 0.952 / 0.987 | 0.990 / 0.991 | 0.990 / 0.990 |
| GC 耗时 w0 / w1（s/s） | 0.048 / 0.100 | 0.055 / 0.102 | 0.088 / 0.081 | 0.079 / 0.081 |
| heap 峰值 w0 / w1 | 156 / 239 MB | 158 / 251 MB | 210 / 206 MB | 206 / 212 MB |
| mongo `role_coll.find` 平均 w0 / w1 | 2 / 193 ms | 2 / 194 ms | 60 / 59 ms | 60 / 60 ms |
| mongo `find` p99 所在桶 w0 / w1 | (5, 10] / (200, 500] | (5, 10] / (200, 500] | 两侧 (50, 100] | 两侧 (50, 100] |
| 进程 CPU（/proc 合计） | 3.272 核 | 3.295 核 | 3.420 核 | 3.370 核 |
| 每次请求的进程 CPU | 985 µs | 999 µs | 974 µs | 959 µs |
| zonesvr rss 峰值 | 1097 MB | 1094 MB | 1114 MB | 1105 MB |

### 5.1 ramp 期在途数（第 1 次运行，15 s 步长，单位：排队中的 handler 数）

```
             0s  15s  30s  45s  60s  75s  90s 105s 120s
轮询      w0   0   58   12    9    5   10   17   11    4
          w1   0  110  420  683  946  975  947  911  868
leastLoad w0   0   67  215  349  468  493  479  460  440
          w1   0   93  223  343  474  487  478  461  441
```

### 5.2 解读

- **吞吐 +6.2 %**：轮询下总吞吐卡在 2 × w1 的速率，w0 还有约 5 % 空闲（ELU 0.95）；leastLoad 下两侧 ELU 都是 1.00。
- **平均耗时只降 6.4 %**：Little 定律（平均在途数 = 吞吐 × 平均耗时）对得上——轮询 887 在途 / 3320 QPS = 267 ms，leastLoad 882 / 3512 = 251 ms。
- **两侧都约 230 ms**：快的一侧从 8 ms 升上来，慢的一侧从约 508 ms 降下来。这是闭环满载下的正确结果，不是"把一侧慢扩散成两侧慢"。
- **GC 总量略升**（轮询 0.15~0.16 s/s，leastLoad 0.16~0.17 s/s），从集中在一侧变成两侧均摊。

### 5.3 闭环下耗时由 bot 数决定

- mongo / redis 的耗时两侧收敛到一致，但不会降到个位数毫秒：每侧约 440 个在途请求的事件循环排队都计入了 `timedColl` 的墙钟时间（07-26 §5.5.1 的机制）。真实的 mongo 延迟只能在低负载一侧看到（轮询下 w0 平均 2 ms）。
- 要降耗时只能加容量（worker 数，可用场景 C）或减压力（bot 数 / think time）。换负载均衡策略只能通过提高吞吐间接影响耗时。
- **在途数告警**（07-26 §8-P1 第 3 条的 `> 200`）在闭环满载压测下会常亮（leastLoad 下每侧稳态约 440）。分裂已经由 LB 从机制上消除；如果仍要告警，应该看两侧在途数的比值，而不是绝对值。

## 六、CPU 上涨分析

### 6.1 结论：上涨来自吞吐，每次请求的 CPU 在下降

| 线程 | 07-26 run2（核） | 轮询（核，2 次均值） | leastLoad（核，2 次均值） | leastLoad − 轮询 |
|---|---:|---:|---:|---:|
| main | 0.63 | 0.640 | 0.640 | 0 |
| 2 个业务 worker | 1.83 | 1.938 | 1.981 | +0.043 |
| V8Worker（internal） | 未记录 | 0.664 | 0.735 | +0.071 |
| 日志线程（logger central） | 未记录 | 0.041 | 0.040 | 0 |
| **进程合计** | — | **3.284** | **3.395** | **+0.111（+3.4 %）** |
| QPS | 3075 | 3308.5 | 3513 | +6.2 % |

| 每次 rank 查询（µs） | 07-26 run2 | 轮询 | leastLoad | 变化 |
|---|---:|---:|---:|---:|
| main | 205 | 193.5 | 182 | −11.5 |
| 2 个业务 worker | 595 | 585.5 | 563.5 | −22 |
| V8Worker | 未记录 | 201 | 209 | +8（同配置单次在 196~214 间波动） |
| 日志线程 | 未记录 | 12 | 11 | −1 |
| **进程合计** | — | **992** | **966.5** | **−25.5（−2.6 %）** |

- 多出来的 0.111 核：worker 的 0.043 核是轮询下 w0 原本闲着的约 5 % 被用上了；V8Worker 的 0.071 核随分配量（≈ 吞吐）增长，每次请求基本持平。
- 每次请求变便宜，主要来自"线程睡下再被唤醒"的次数变少：两个 worker 现在一直有活，不再空闲下来。见 §6.3 的 `idle` 列。这个归因是推断，没有逐项验证。

### 6.2 V8Worker 是什么

leastLoad #2 运行期间 zonesvr 进程的线程，按 /proc 线程名统计：

| 线程名 | 个数 | 每个的 CPU（核） | 说明 |
|---|---:|---:|---|
| `node …`（main） | 1 | 0.634 | 主线程 |
| `WorkerThread` | 3 | 0.990 / 0.990 / 0.039 | 2 个业务 worker + 1 个日志线程 |
| `V8Worker` | 4 | 0.172 ~ 0.174 | V8 平台线程池，进程内所有 isolate 共用；做 GC 的并发 / 并行部分和 JIT 后台编译（推断：稳态下以 GC 为主） |
| `v8:ProfEvntProc` | 3 | 0.004 ~ 0.005 | 每个 isolate 一个，CPU profiler 事件处理（Pyroscope 开启时才有） |
| `libuv-worker` | 4 | 0.002 ~ 0.003 | libuv 线程池，本场景几乎不用 |
| `DelayedTaskSche` / `SignalInspector` | 1 / 1 | ≈ 0 | — |

V8Worker 约占进程 CPU 的 21 %（约 200 µs/查询），是 07-26 原文里 `:Non JS threads activity:` 桶的主体。要压这一项只能减少内存分配。Pyroscope 里该桶的读数（0.55~0.86 核）与 /proc（0.65~0.75 核）对不上，原因见 §7.4，以 /proc 为准。

### 6.3 每次请求的分类拆解（Pyroscope 比例 × /proc CPU，2 次均值，µs/查询）

分类定义见附录 C.3；每次运行的数值见附录 B。

| main 线程 | 轮询 | leastLoad | 差 |
|---|---:|---:|---:|
| idle（无 JS 帧的原生耗时） | 77.4 | 63.5 | −13.9 |
| tsrpc / tsbuffer 编解码 | 55.7 | 58.2 | +2.5 |
| other（其余 JS） | 23.1 | 22.9 | −0.2 |
| socket 写（writev 等） | 20.5 | 20.1 | −0.4 |
| IPC（SAB / postMessage 相关） | 6.0 | 4.8 | −1.2 |
| GC（主线程停顿部分） | 5.4 | 7.5 | +2.1 |
| otel | 3.1 | 2.9 | −0.2 |
| logger | 2.4 | 2.4 | 0 |
| **合计** | **193.5** | **182** | **−11.5** |

| 2 个 worker 合计 | 轮询 | leastLoad | 差 |
|---|---:|---:|---:|
| other（handler、async、Node 内部） | 178.7 | 169.4 | −9.3 |
| mongodb driver（不含 bson） | 124.8 | 124.2 | −0.6 |
| bson 编解码 | 73.9 | 76.5 | +2.6 |
| socket 写 | 55.4 | 55.0 | −0.4 |
| GC（worker 停顿部分） | 50.7 | 51.4 | +0.7 |
| redis 客户端 | 35.1 | 34.8 | −0.3 |
| idle | 35.0 | 23.5 | −11.5 |
| otel | 17.5 | 17.4 | −0.1 |
| IPC | 10.9 | 8.4 | −2.5 |
| logger | 4.1 | 3.2 | −0.9 |
| **合计** | **585.9** | **563.7** | **−22.2** |

下降集中在 `idle`（main −13.9、worker −11.5）、IPC 和 worker 的 `other`；业务编解码（tsrpc、bson、redis、mongodb）基本不变。

## 七、SAB vs postMessage 复测（验收 2026-09 的 SAB 优化）

### 7.1 A/B（两组都用 leastLoad）

| 指标 | SAB #1 | SAB #2 | postMessage #1 | postMessage #2 | SAB 相对 postMessage（均值） |
|---|---:|---:|---:|---:|---:|
| cmd 20004 QPS | 3512 | 3514 | 3436 | 3419 | **+2.5 %** |
| cmd 平均耗时 | 250.7 ms | 250.4 ms | 254.7 ms | 255.8 ms | −1.8 % |
| bot RTT p50 / p99 | 294 / 496 ms | 280 / 496 ms | 291 / 496 ms | 295 / 496 ms | — |
| 进程 CPU（/proc 合计） | 3.420 核 | 3.370 核 | 3.438 核 | 3.430 核 | — |
| **每次请求的进程 CPU** | 974 µs | 959 µs | 1001 µs | 1003 µs | **−3.5 %** |
| 　main | 184 | 180 | 194 | 191 | −10.5 µs |
| 　2 个 worker | 564 | 563 | 575 | 577 | −12.5 µs |
| 　日志线程 | 11 | 11 | 32 | 33 | −21.5 µs |
| 　V8Worker | 214 | 204 | 200 | 202 | +8 µs（在单次波动范围内） |
| IPC 的 JS 耗时（main + worker） | 12.6 µs | 13.8 µs | 27.2 µs | 27.4 µs | 约 −14 µs |
| 主线程侧在途 − worker 侧排队（每侧） | 约 1 | 约 0 | 5 ~ 12 | 15 ~ 17 | 通道内滞留更少 |
| zonesvr rss 峰值 | 1114 MB | 1105 MB | 1112 MB | 1112 MB | ≈ |

同配置两次之差：SAB QPS 0.08 %、每次请求 CPU 1.6 %；postMessage QPS 0.5 %、每次请求 CPU 0.2 %。两组之差均超出该范围。

### 7.2 收益来自哪里

- **最大一项是日志通道**（−21.5 µs/查询）：压测用 `log.level: trace`，每次请求会产生多行日志。走 postMessage 时每行都是一条线程间消息，日志线程逐条接收；走 SAB 时日志线程按批读取。
- **消息通道**：main 侧 IPC 11.3 → 4.8 µs/查询，worker 侧 16.1 → 8.4 µs/查询（附录 B）。
- main 线程的 `idle` 在 SAB 下反而高约 4 µs/查询（63.5 vs 59.2），推测与 SAB 等待唤醒（`waitAsync`）的原生开销有关；tsrpc 编解码在两组间差约 5 µs/查询，原因未解释（同样的代码，轮询组更低，为 55.7）。

### 7.3 07-26 §5.7 各项问题的状态

| 07-26 §5.7 的问题 | 现状 | 证据 |
|---|---|---|
| `sab_ring.resetIndexes` 是 IPC 最大热点（main 约 9.7 µs/op） | 已消失 | 今天的 profile 中无该帧，`sab_ring.js` 只剩 `claim` / `commit` / `drain` / `hasRoom` |
| 每条消息付两次 `Atomics.notify` | main → worker 方向基本消除；worker → main 方向仍约每条回包一次 | §7.5 |
| head 走 JSON 编解码 | 已改为定长二进制 | 2026-09 提交；耗时已含在上表 IPC 内 |
| pump 每条消息走一次 `setImmediate` | 已改为批量 drain | `sab_pump.js:loop` 自身耗时 ≤ 0.05 s / 次运行 |
| SAB 的 IPC JS 开销高于 postMessage | 现在约为 postMessage 的一半 | 13 vs 27 µs/查询（07-26 时 SAB 约 33、postMessage 约 23.5，按原文换算，误差约 ±20 %） |
| "SAB 进程 wall:cpu 反而 +10 %" | 原本就是测量噪声 | §7.4 |
| **SAB 是否跑赢 postMessage** | **是** | §7.1 |

07-26 时 SAB 相对 postMessage 的 QPS 是 +3.3 %（各只跑一次，没有同配置重复，无法判断是否超出噪声）；今天是 +2.5 %，且有重复。

### 7.4 测量方法：Pyroscope 整段总量的 ±10 % 噪声

| 配置 | Pyroscope 整段总量（3 个 isolate 合计，317 s 窗口）#1 / #2 | 差 | /proc 稳态 CPU #1 / #2 | 差 |
|---|---:|---:|---:|---:|
| 轮询 | 983.6 / 896.8 s | −8.8 % | 3.272 / 3.295 核 | +0.7 % |
| leastLoad | 1031.4 / 926.3 s | −10.2 % | 3.420 / 3.370 核 | −1.5 % |
| postMessage | 930.3 / 933.5 s | +0.3 % | 3.438 / 3.430 核 | −0.2 % |

- 原因：pyroscope-nodejs 每个 isolate 大约每 60 s 上传一块 profile（满载 worker 的 timeline 上每 60 s 一个约 57~60 s CPU 的块）。317 s 的窗口会包含 5~7 块完整或不完整的数据，取决于对齐位置，所以总量最多会差一块。
- 07-26 §5.7 的"892 → 985 s（+10 %）"落在这个范围内，不能作为"SAB 更费 CPU"的证据。
- 正确用法：Pyroscope 只用来看比例；绝对 CPU 用 /proc（`dogsvr_thread_cpu_utilization`）。本文所有绝对值都按此换算（§2.3）。

### 7.5 剩余开销：worker → main 每条回包约一次唤醒

`sab_ring.js` 的 `commit` 自身耗时（µs/查询）：

| 运行 | main 侧 commit（main → worker） | main 侧 `park` | worker 侧 commit（worker → main） | worker 侧 `park` |
|---|---:|---:|---:|---:|
| 轮询 #1 | 0.61 | 1.40 | 7.24 | 0.35 |
| 轮询 #2 | 0.55 | 1.31 | 6.78 | 0.24 |
| leastLoad #1 | 0.28 | 0.88 | 5.03 | 0.00 |
| leastLoad #2 | 0.37 | 1.03 | 5.20 | 0.01 |

- `commit` 里纯 JS 的操作只有两次 `setInt32`、一次 `Atomics.store`、一次 `Atomics.load`，只要几十纳秒。微秒级的自身耗时只能来自其中的 `Atomics.notify`（唤醒一个等待中的线程，2026-09 实测约 5.9 µs/次）。由此推断：worker → main 方向几乎每条回包都要唤醒一次 main。
- 原因：main 只用了约 64 % 的 CPU，消息通道的读取端用 `"park"` 模式，读空就进入等待，所以每条回包都会撞上"对端在等"。反方向的 worker 一直满载，很少进入等待，所以 main 侧 commit 很低。
- 可选优化：main 侧读取端读空后先短暂轮询再等待。上限约 5 µs/查询（约 0.5 %），不急。

## 八、整体性能：与 07-26 对比

| 指标 | 07-26 run1（postMessage，轮询） | 07-26 run2（SAB，轮询） | 10-17 轮询（SAB，2 次均值） | 10-17 leastLoad（SAB，2 次均值） |
|---|---:|---:|---:|---:|
| cmd 20004 QPS | 2977 | 3075 | 3308.5 | 3513 |
| 相对 07-26 run2 | −3.2 % | — | +7.6 % | **+14.2 %** |
| cmd p99 | 988 ms | 988 ms | (500, 1000] 桶 | (200, 500] 桶 |
| bot RTT p50 / p95 / p99 | 41 / 928 / 986 ms | 53 / 896 / 979 ms | 39 / 900 / 980 ms | 287 / 479 / 496 ms |
| cmd 平均耗时 | — | 约 286 ms（估算：约 880 在途 ÷ 3075） | 267.6 ms | 250.5 ms |
| main 线程 CPU | 约 0.60（由 Pyroscope 推算） | 0.63 | 0.640 | 0.640 |
| worker 线程 CPU w0 / w1 | 0.88 / 0.93 | 0.90 / 0.93 | 0.95 / 0.99 | 0.99 / 0.99 |
| 每次请求 main | — | 205 µs | 193.5 µs | 182 µs（−11 %） |
| 每次请求 worker | 约 608 µs | 595 µs | 585.5 µs | 563.5 µs（−5.3 %） |
| **每次请求 main + worker** | — | **800 µs** | **779 µs** | **746 µs（−6.8 %）** |
| zonesvr rss | 1128 MB | 1148 MB | 1095 MB | 1109 MB（−3.4 %） |
| 错误率 | 0 | 0 | 0 | 0 |

07-26 的数据取自原文 §三、§5.1 和 07-26 两份报告的 summary；07-26 未记录 V8Worker 和日志线程，所以跨日期只比 main + worker。相对 07-26 run1 的 QPS 提升是 +18.0 %。

**+14.2 % 由两段组成，可信度不同**：

| 段 | 提升 | 代码差异 | 可信度 |
|---|---:|---|---|
| 07-26 run2 → 10-17 轮询 | +7.6 % | 只有 2026-09 ~ 10 的 SAB 优化（§〇） | 跨日期、07-26 只跑一次，含环境漂移，无法剥离 |
| 10-17 轮询 → leastLoad | +6.2 % | 本次 lb fix | 同会话 A/B，可信 |

第一段的细节：轮询下 QPS = 2 × 卡住那侧 worker 的速率。卡住的 w1 每次请求的 CPU 几乎没变（07-26：0.93 核 / 1547 = 601 µs；今天：595 / 599 µs），提升来自它拿到的 CPU 时间从 0.93 核增到 0.99 核（ELU 0.96 → 1.00）。07-26 时它丢掉的那约 6 % 时间去了哪里（候选：旧 SAB 实现的等待 / 唤醒间隙、机器背景负载），因原始数据已过期无法再查。要量出环境漂移，可以今天再跑一次"postMessage + 轮询"与 07-26 run1（2977）对比——postMessage 路径在这期间改动较少。

## 九、遗留

- 热更新期间"SAB 在 init 后才开始消费"的效果未实测（`d_hot_update`）。
- 轮询下 4 次都卡在 w1 的系统性偏向来源未定位（轮询已不是默认策略，优先级低）。
- worker → main 每条回包约一次 `Atomics.notify`（约 5 µs/查询），见 §7.5。
- 07-26 → 10-17 的 +7.6 % 中环境漂移未剥离（建议跑"postMessage + 轮询"对照）。
- main 线程 tsrpc 编解码每次请求在不同配置间 55~64 µs 波动，原因未解释。
- 登录场景（`e_login_qps`，瓶颈在主线程）未复测，SAB 优化与 leastLoad 对它的影响未知。
- leastLoad 已知盲区，本次不处理：
  - 静默丢弃（handler 返回 `undefined`）的 txn 要挂 5 s 才超时，期间在途数虚高；zonesvr 只在错误路径上出现。
  - 不区分请求成本，等远端 I/O 的请求也算作负载。
  - 某个 worker 自身依赖坏掉（例如它自己的 redis 连接断开）时快速失败，同样会被当成空闲，需要异常剔除机制。

07-26 原文中与本文结论相关的位置（§一、§2.2、§2.3、§5.5、§5.7、§六、§7.4、§八、§九）都已加 `【2026-10】` 注并指回本文。

---

## 附录 A：每次运行的完整 Prometheus 数据

窗口为开始后 60~300 s。分位数为 `histogram_quantile` 的插值，只精确到桶（§2.3）。"—"表示该配置下无此指标。

| 指标 | 轮询 #1 | 轮询 #2 | leastLoad #1 | leastLoad #2 | postMessage #1 | postMessage #2 |
|---|---:|---:|---:|---:|---:|---:|
| cmd 20004 QPS | 3320.4 | 3297.2 | 3511.7 | 3514.5 | 3436.0 | 3419.4 |
| cmd 20004 平均耗时（ms） | 266.9 | 268.3 | 250.7 | 250.4 | 254.7 | 255.8 |
| cmd 20004 p50 / p95 / p99（ms） | 201 / 934 / 987 | 200 / 935 / 987 | 350 / 485 / 497 | 350 / 485 / 497 | 348 / 485 / 497 | 348 / 485 / 497 |
| bot RTT p50 / p95 / p99（ms） | 38.4 / 905.3 / 981.1 | 40.6 / 895.6 / 979.1 | 294.4 / 479.4 / 495.9 | 279.8 / 478.0 / 495.6 | 291.4 / 479.1 / 495.8 | 295.1 / 479.5 / 495.9 |
| `worker_cmd_hdl` 速率 w0 / w1（/s） | 1660 / 1661 | 1648 / 1649 | 1742 / 1770 | 1755 / 1759 | 1730 / 1706 | 1717 / 1702 |
| `worker_cmd_hdl` 平均 w0 / w1（ms） | 8 / 507 | 9 / 509 | 233 / 229 | 231 / 231 | 227 / 231 | 229 / 231 |
| `worker_cmd_hdl` p50 w0 / w1（ms） | 7 / 522 | 8 / 562 | 337 / 330 | 337 / 336 | 314 / 321 | 317 / 322 |
| `worker_cmd_hdl` p99 w0 / w1（ms） | 28 / 990 | 38 / 991 | 497 / 497 | 497 / 497 | 496 / 496 | 496 / 496 |
| `worker_cmd_hdl_pending` 均值 w0 / w1 | 14 / 875 | 16 / 873 | 440 / 440 | 443 / 442 | 427 / 434 | 427 / 425 |
| 主线程侧在途 `dogsvr_worker_pending` 均值 w0 / w1 | 16 / 871 | 16 / 870 | 441 / 441 | 442 / 441 | 439 / 439 | 442 / 442 |
| ELU w0 / w1 | 0.951 / 1.000 | 0.957 / 1.000 | 1.000 / 1.000 | 1.000 / 1.000 | 1.000 / 1.000 | 1.000 / 1.000 |
| event loop lag 均值 w0 / w1（s，含 0.010 基线） | 0.010 / 0.030 | 0.011 / 0.030 | 0.029 / 0.028 | 0.028 / 0.028 | 0.029 / 0.029 | 0.029 / 0.029 |
| GC 耗时 w0 / w1（s/s） | 0.048 / 0.100 | 0.055 / 0.102 | 0.088 / 0.081 | 0.079 / 0.081 | 0.077 / 0.076 | 0.075 / 0.076 |
| heap 峰值 w0 / w1（MB） | 156 / 239 | 158 / 251 | 210 / 206 | 206 / 212 | 195 / 222 | 224 / 208 |
| mongo `role_coll.find` 平均 w0 / w1（ms） | 2 / 193 | 2 / 194 | 60 / 59 | 60 / 60 | 55 / 56 | 56 / 56 |
| mongo `find` p99 w0 / w1（ms） | 8 / 491 | 9 / 492 | 100 / 100 | 100 / 100 | 100 / 100 | 100 / 100 |
| redis `zRangeWithScores` p99 w0 / w1（ms） | 9 / 99 | 10 / 99 | 99 / 99 | 99 / 99 | 100 / 100 | 100 / 100 |
| redis `zRevRank` p99 w0 / w1（ms） | 9 / 106 | 9 / 106 | 100 / 99 | 99 / 99 | 100 / 122 | 100 / 117 |
| 线程 CPU main（核） | 0.643 | 0.636 | 0.646 | 0.634 | 0.666 | 0.653 |
| 线程 CPU worker 合计（核） | 1.937 | 1.939 | 1.981 | 1.980 | 1.975 | 1.974 |
| 　worker 两个 tid（核） | 0.947 / 0.989 | 0.952 / 0.987 | 0.990 / 0.991 | 0.990 / 0.990 | 0.987 / 0.989 | 0.986 / 0.988 |
| 线程 CPU V8Worker（internal，核） | 0.650 | 0.678 | 0.753 | 0.717 | 0.687 | 0.691 |
| 线程 CPU 日志线程（核） | 0.041 | 0.041 | 0.040 | 0.039 | 0.110 | 0.112 |
| 线程 CPU 进程合计（核） | 3.272 | 3.295 | 3.420 | 3.370 | 3.438 | 3.430 |
| 每次请求 main / worker / V8Worker / 日志（µs） | 194 / 583 / 196 / 12 | 193 / 588 / 206 / 12 | 184 / 564 / 214 / 11 | 180 / 563 / 204 / 11 | 194 / 575 / 200 / 32 | 191 / 577 / 202 / 33 |
| 每次请求进程合计（µs） | 985 | 999 | 974 | 959 | 1001 | 1003 |
| zonesvr rss 峰值（MB） | 1097 | 1094 | 1114 | 1105 | 1112 | 1112 |
| SAB fallback 速率（/s） | 0 | 0 | 0 | 0 | — | — |
| bot 错误率 | 0.00 % | 0.00 % | 0.00 % | 0.00 % | 0.00 % | 0.00 % |

mongo / redis 指标没有 `worker_index` 标签，按 `service_instance_id`（`zonesvr-worker-0` / `-1`）区分。

## 附录 B：每次运行的 Pyroscope 分类拆解（µs/查询）

窗口为开始后 75~300 s，换算方法见 §2.3，分类定义见附录 C.3。

**main 线程**（不含 Non JS 桶）：

| 分类 | 轮询 #1 | 轮询 #2 | leastLoad #1 | leastLoad #2 | postMessage #1 | postMessage #2 |
|---|---:|---:|---:|---:|---:|---:|
| idle | 78.2 | 76.6 | 63.2 | 63.8 | 58.4 | 60.0 |
| tsrpc | 54.9 | 56.5 | 59.3 | 57.0 | 64.2 | 61.9 |
| other | 22.6 | 23.6 | 24.1 | 21.7 | 21.8 | 20.9 |
| socket | 21.0 | 19.9 | 20.3 | 19.8 | 23.5 | 21.8 |
| ipc | 6.2 | 5.8 | 4.5 | 5.1 | 11.0 | 11.5 |
| gc | 5.4 | 5.3 | 7.6 | 7.3 | 8.3 | 8.1 |
| otel | 3.1 | 3.0 | 2.6 | 3.2 | 4.0 | 4.1 |
| logger | 2.3 | 2.4 | 2.4 | 2.3 | 2.6 | 2.5 |
| 合计（= /proc main） | 194 | 193 | 184 | 180 | 194 | 191 |

**2 个 worker 合计**：

| 分类 | 轮询 #1 | 轮询 #2 | leastLoad #1 | leastLoad #2 | postMessage #1 | postMessage #2 |
|---|---:|---:|---:|---:|---:|---:|
| other | 175.7 | 181.7 | 167.5 | 171.2 | 171.1 | 172.2 |
| mongodb | 125.7 | 123.9 | 124.5 | 123.9 | 125.5 | 126.4 |
| bson | 73.0 | 74.7 | 76.3 | 76.7 | 74.8 | 77.6 |
| socket | 56.3 | 54.5 | 55.0 | 55.0 | 56.7 | 56.0 |
| gc | 49.2 | 52.1 | 52.6 | 50.2 | 49.8 | 49.6 |
| idle | 36.1 | 33.9 | 23.7 | 23.2 | 25.5 | 24.6 |
| redis | 34.8 | 35.3 | 35.3 | 34.3 | 33.8 | 33.7 |
| otel | 17.5 | 17.4 | 17.7 | 17.1 | 17.6 | 16.7 |
| ipc | 11.0 | 10.7 | 8.1 | 8.7 | 16.2 | 15.9 |
| logger | 4.2 | 4.0 | 3.3 | 3.1 | 3.9 | 4.6 |
| 合计（= /proc worker） | 583 | 588 | 564 | 563 | 575 | 577 |

**Pyroscope 整段总量**（开始到结束 317 s，3 个 isolate 合计，仅用于 §7.4 的噪声说明）：轮询 983.6 / 896.8 s，leastLoad 1031.4 / 926.3 s，postMessage 930.3 / 933.5 s。

## 附录 C：查询方法

### C.0 脚本

附录 A、附录 B 和 §7.5 的表格都由 [`scripts/zonesvr_run_stats.py`](scripts/zonesvr_run_stats.py) 生成（只用 Python 标准库）。在 `example-proj-stress/` 下运行：

```sh
# 附录 A：Prometheus 稳态窗口，每次运行一列
python3 analysis/scripts/zonesvr_run_stats.py prom reports/<run1> reports/<run2> ... --names A,B,...
# 附录 B + §7.5 + §7.4 的 Pyroscope 部分
python3 analysis/scripts/zonesvr_run_stats.py pyro reports/<run1> reports/<run2> ... --names A,B,...
# 加 --json 输出原始数值；--prom / --pyro 改端点；--cmd-id 改归一化用的 cmd（默认 20004）
```

窗口由各报告 `summary.md` 里的开始时间、`durationMs`、`rampMs` 推出，与 §2.3 一致。前提是 Prometheus 和 Pyroscope 里还保留着这几次运行的数据。下面 C.1 ~ C.4 是脚本内部用到的查询，供不跑脚本时核对。

### C.1 Prometheus（`http://127.0.0.1:9090`，在开始 + 300 s 时刻求值）

```
# QPS 与平均耗时
sum(rate(dogsvr_cmd_duration_milliseconds_count{svr="zonesvr",cmdId="20004"}[4m]))
sum(rate(dogsvr_cmd_duration_milliseconds_sum{svr="zonesvr",cmdId="20004"}[4m])) / sum(rate(dogsvr_cmd_duration_milliseconds_count{svr="zonesvr",cmdId="20004"}[4m]))
histogram_quantile(0.99, sum by (le)(rate(dogsvr_cmd_duration_milliseconds_bucket{svr="zonesvr",cmdId="20004"}[4m])))

# worker 侧（按 worker_index 分组）
sum by (worker_index)(rate(dogsvr_worker_cmd_hdl_duration_milliseconds_count{svr="zonesvr-worker",cmd_id="20004"}[4m]))
avg by (worker_index)(avg_over_time(dogsvr_worker_cmd_hdl_pending{svr="zonesvr-worker"}[4m]))
avg by (worker_index)(avg_over_time(dogsvr_worker_elu_utilization{svr="zonesvr-worker"}[4m]))
avg by (worker_index)(avg_over_time(dogsvr_worker_eventloop_lag_seconds{svr="zonesvr-worker"}[4m]))
sum by (worker_index)(rate(dogsvr_worker_gc_duration_seconds_sum{svr="zonesvr-worker"}[4m]))
max by (worker_index)(max_over_time(dogsvr_worker_heap_used_bytes{svr="zonesvr-worker"}[4m]))

# 主线程侧在途
avg by (worker_index)(avg_over_time(dogsvr_worker_pending{svr="zonesvr"}[4m]))

# mongo / redis（按 service_instance_id 分组）
sum by (service_instance_id)(rate(mongo_op_duration_milliseconds_sum{svr="zonesvr-worker",coll="role_coll",op="find.toArray"}[4m])) / sum by (service_instance_id)(rate(mongo_op_duration_milliseconds_count{svr="zonesvr-worker",coll="role_coll",op="find.toArray"}[4m]))
histogram_quantile(0.99, sum by (le, service_instance_id)(rate(redis_op_duration_milliseconds_bucket{svr="zonesvr-worker",op="zRevRank"}[4m])))

# 线程 CPU（/proc）
sum by (thread_role)(avg_over_time(dogsvr_thread_cpu_utilization{svr="zonesvr"}[4m]))
avg_over_time(dogsvr_thread_cpu_utilization{svr="zonesvr",thread_role="worker"}[4m])

# 其他
max_over_time(dogsvr_process_rss_bytes{svr="zonesvr"}[4m])
sum(rate(dogsvr_msg_channel_fallback_total{svr="zonesvr"}[4m]))
```

### C.2 Pyroscope（`http://127.0.0.1:4040`）

- 接口：`GET /pyroscope/render?query=<q>&from=<unix s>&until=<unix s>&format=json&max-nodes=0`，返回 flamebearer。`levels` 中每 4 个整数为一个节点 `[offset, total, self, nameIndex]`，按 `names[nameIndex]` 汇总 `self`。
- profile 类型 `wall:cpu:nanoseconds:wall:nanoseconds`；选择器：main 为 `{service_name="zonesvr",thread="main"}`，worker 为 `{service_name="zonesvr",thread="worker",worker_index="0"}`（或 `"1"`）。
- main isolate 的 `:Non JS threads activity:0` 桶不计入 main 线程，单独以 /proc 的 internal 为准。
- `timeline` 字段可以看到约 60 s 一块的上传粒度（§7.4）。

### C.3 分类规则（按函数名匹配，先匹配到的优先）

| 分类 | 匹配 |
|---|---|
| ipc | `sab_*.js`（dogsvr 消息通道、logger 日志通道）、`:postMessage:`、`node:internal/worker:postMessage`、`messageport` |
| tsrpc | `tsbuffer`、`tsrpc`、`cl-tsrpc` |
| bson | `bson` |
| redis | `@redis` |
| mongodb | `node_modules/mongodb/` |
| logger | `pino`、`/logger/` |
| otel | `opentelemetry`、`/otel/` |
| socket | `:writev:`、`:writeBuffer:`、`:writeUtf8String:`、`:writeLatin1String:` |
| gc | `:Garbage Collection:` |
| idle | `:(idle):` |
| other | 以上都不匹配 |

### C.4 线程名

`for t in /proc/$(pm2 pid exp-zonesvr)/task/*; do echo "$(basename $t) $(cat $t/comm)"; done`，与 `dogsvr_thread_cpu_utilization` 的 `tid` 标签对照（§6.2）。
