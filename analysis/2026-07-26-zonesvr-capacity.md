# zonesvr 容量分析

_2026-07-26 · 基于三次压测 + Pyroscope wall profile + Prometheus 指标_

## 目录

- [一、结论摘要](#一结论摘要)
- [二、测试环境与观测口径](#二测试环境与观测口径)
  - [2.1 三种"主线程 CPU %核"口径对照](#21-三种主线程-cpu-核口径对照run2-rank3174-s-窗口)
  - [2.2 各成分是否算进"主线程 tid"](#22-各成分是否算进主线程-tid)
  - [2.3 使用建议](#23-使用建议)
- [三、三次压测数据汇总](#三三次压测数据汇总)
- [四、场景一：短连接重连风暴（登录 QPS）](#四场景一短连接重连风暴登录-qps)
  - [4.1 现象](#41-现象)
  - [4.2 主线程 CPU 分布](#42-主线程-cpu-分布07-18-窗口top-桶isolate--17887-s)
  - [4.3 判断](#43-判断)
- [五、场景二：长连接稳态业务（rank 查询）](#五场景二长连接稳态业务rank-查询)
  - [5.1 现象](#51-现象)
  - [5.2 主线程 CPU 分布](#52-主线程-cpu-分布run2-wallcpuisolate--42424-s)
  - [5.3 Worker CPU 分布](#53-worker-cpu-分布run2-w0-wallcpuisolate--2756-s)
  - [5.4 QPS 与远端依赖的对应](#54-qps-与远端依赖的对应)
  - [5.5 Worker 之间的负载不均](#55-worker-之间的负载不均)
    - [5.5.1 关键辨别：mongo 本身没变慢](#551-关键辨别mongo-本身没变慢)
    - [5.5.2 那 "w1 事件循环拥堵" 又是为什么？](#552-那-w1-事件循环拥堵-又是为什么)
    - [5.5.3 heap / GC 差异是被拉高的，不是根因](#553-heap--gc-差异是被拉高的不是根因)
    - [5.5.4 排除的候选](#554-排除的候选)
    - [5.5.5 验证与修复顺序](#555-验证与修复顺序)
    - [5.5.6 LeastLoad 能识别 tick lag 吗](#556-leastload-能识别-tick-lag-吗)
  - [5.6 判断](#56-判断)
  - [5.7 SAB 为什么没跑赢 postMessage](#57-sab-为什么没跑赢-postmessage)
    - [5.7.1 IPC 每 op 成本量化](#571-ipc-每-op-成本量化)
    - [5.7.2 实现层面：当前 SAB 的 fixed cost 项](#572-实现层面当前-sab-的-fixed-cost-项)
    - [5.7.3 场景层面：为什么这些 fixed cost 会显现](#573-场景层面为什么这些-fixed-cost-会显现)
    - [5.7.4 分层判断](#574-分层判断)
    - [5.7.5 SAB 什么时候真的赢](#575-sab-什么时候真的赢)
    - [5.7.6 可以动的实现优化方向](#576-可以动的实现优化方向不承诺仅列方向)
- [六、分场景是否合理？—— 分析](#六分场景是否合理--分析)
- [七、容量预估](#七容量预估)
  - [7.1 zonesvr 单机上限](#71-zonesvr-单机上限当前配置1-main--2-worker)
  - [7.2 单实例 rss](#72-单实例-rss)
  - [7.3 与业务参照数据的对齐](#73-与业务参照数据的对齐zone_limitmd)
- [八、建议的动作（优先级）](#八建议的动作优先级)
  - [P0（零风险 / 一步生效）](#p0零风险--一步生效)
  - [P1（修复 §5.5 bistable 分裂）](#p1修复-55-bistable-分裂--需组合执行)
  - [P2（进一步降 mongo/redis QPS）](#p2进一步降-mongoredis-qps)
  - [P3（观测缺口 / 中长期）](#p3观测缺口--中长期)
- [九、遗留问题](#九遗留问题)
- [附：Prometheus 查询窗口](#附prometheus-查询窗口)

---

## 一、结论摘要

- zonesvr 存在**两条互不相干的 hot path**，容量应分开算：
  1. **短连接重连风暴**（`e_login_qps`）——瓶颈**结构上落在 zonesvr 主线程**：ws 握手 / 关闭链 / tsrpc 编解码 / socket writev 全部集中在主线程，业务 worker 用不到 18 % 单核。07-12 观测 QPS 上限约 **2.24 k connect+login/s** 时 main tid ≈ 100 %（**那次没保留 profile**，只有 07-18 · 1.38 k/s / tid 46.6 % 的 profile 支持定性结论）。详见 §四。
  2. **长连接稳态业务**（`f_realistic_session` rank 查询）——瓶颈在 **worker 编解码 CPU** 与 **RoundRobin + bistable 分裂造成的 event loop 拥堵**：main tid 60~64 %，两个 worker 分别 90 %/93 %。当前配置天花板约 **3.1 k rank query/s**。详见 §五。
- **重要辨别（§5.5）**：cmd p99 988 ms、`mongo_op_duration` p99 484 ms 看似是"mongo 慢"，其实**不是**——同 svr 的 w0 报出的 mongo p99 = 9 ms 才是这台 mongo 的真实延迟。w1 侧长尾是 event loop tick lag 把 `mongo_proxy.timedColl` 里的墙钟计时拉长，redis 五种独立 op 也同步长尾 10~14× 是决定性证据。真正的问题是 **RoundRobin 负载均衡把 w1 卡在深队列稳态**。
- **用户"重连风暴 vs 普通业务分开分析"合理**：同一份代码两种压力下 CPU 分布相反（主线程 100 % vs 64 %，worker 18 % vs 93 %），瓶颈原因、扩容杠杆都不同。
- **SAB vs postMessage 差异 < 4 %，进程 wall:cpu 反而 +10 %**：详见 §5.7。原因是场景层面 IPC 只占 worker CPU ~5 %，同时当前 SAB 实现每消息 head JSON + resetIndexes seqlock + 多次 Atomics 累计 fixed cost ~10 μs/op 反而超过 postMessage 的 structured clone 成本。
- **核心动作项**（按优先级，详见 §八）：调低压测 log.level → 换 lbStrategy: leastLoad + 加 worker 数 → 加 mongo/redis 缓存降下游依赖 → 补 pending / event_loop_lag 告警与 profile。

---

## 二、测试环境与观测口径

- 单物理机自压：dogsvr 组件（dir / zonesvr / battlesvr, pm2 fork 模式）与压侧（bot 集群 + Prometheus + Grafana + Pyroscope，otel-lgtm 容器）同机，Redis / MongoDB 本机常驻。数值仅相对参考。
- zonesvr 部署：**1 main isolate + 2 worker isolate**（`workerThreadNum=2`），SAB 传输层可选（`channel.msg.transport=sab`）。
- 观测栈：
  - **业务 metric**：Prometheus，OTLP push 5 s。
  - **CPU profile**：Pyroscope，pyroscope-nodejs（`wall.collectCpuTime:true`）；每个 v8 isolate 一份 profile。
  - **口径**（沿用 memory `runbook_pyroscope_cpu_profile.md`）：
    - `%isolate = self / 该 isolate wall:cpu total`：函数在该 isolate 内部的相对权重。
    - `%core = self / 窗口秒数`：占了几个核。
    - **主线程 tid %核（对齐 `top -H` 主 JS 线程那一行）= `(main.wall:cpu − :Non JS threads activity:) / window`**。全文所有"main tid %核"数据统一采用此口径。详细拆解见 §2.1 / §2.2。
    - `wall:wall` = 主 JS 线程的纯忙时（idle 归零，不含 Non-JS），可作 tid 的下界参考。

### 2.1 三种"主线程 CPU %核"口径对照（run2 rank，317.4 s 窗口）

| 视角 | 公式 | 值 | 对齐什么 |
|---|---|---:|---|
| **进程 %CPU**（`top` 里 pm2 zonesvr 那一行） | `main.wall:cpu / window` = 424.24 / 317.4 | **133.7 %** | 进程整行 CPU；**含**主线程 pthread + libuv thread pool + V8 后台 + pyroscope 采样线程等所有主 isolate 关联 pthread |
| **主 JS 线程 tid**（`top -H` 里主线程那一行） | `(main.wall:cpu − Non-JS) / window` = (424.24 − 232.06) / 317.4 | **60.5 %** | `top -H` 主线程 tid；对齐用户观察值（本次 64 %，采样噪声内） |
| **纯 JS 执行**（不算 native / idle / GC） | `wall:wall / window` = 164.03 / 317.4 | **51.7 %** | 只看"业务 JS 代码本身"多忙；不对齐 top 任何一行，是 tid 的**下界** |

### 2.2 各成分是否算进"主线程 tid"

| 成分 | 属于哪个 pthread | 算主线程 tid 吗 | 说明 |
|---|---|:---:|---|
| **JS 帧**（业务代码、tsbuffer、tsrpc、bson 等） | 主线程 | ✅ | 显然 |
| **`:Garbage Collection:0`** | 主线程 | ✅ | V8 stop-the-world GC 就在触发它的 isolate 主线程上跑 |
| **`:(idle):0`** | 主线程 | ✅ | 名字虽叫 idle，实为主线程跑 native C++（syscall 用户态、ws sender native prep、`writev` / `writeUtf8String`、Buffer 编解码等）时 V8 CpuProfiler 抓不到 JS 帧的 fallback，是**真实 CPU**；`top -H` 一样把这部分计给主线程 tid。想彻底剔除这类噪音就直接看 `wall:wall`（pyroscope 硬编码把 idle 归零） |
| **`:Non JS threads activity:0`** | libuv thread pool + V8 后台 optimize + pyroscope 采样线程 —— **各自独立 pthread、独立 tid** | ❌ | 在 `top -H` 里是**另外几行**，不计入主线程 tid 那一行；但会计入 `top` 里进程整行 %CPU |

### 2.3 使用建议

- 想说 **"主线程 CPU 快满了" / "会先饱和"** → 用 `(wall:cpu − Non-JS) / window`；`idle` + `GC` 都在分子里。**本文档"main tid %核"统一采用此口径。**
- 想说 **"业务 JS 代码本身有多忙"** → 用 `wall:wall / window`（idle 归零后的纯 JS 执行时长）。
- 想对齐 **`top` 进程那一行 %CPU** → 用整个 isolate wall:cpu / window（含 Non-JS），或 `Σ (main + 所有 worker isolate).wall:cpu / window`（进程含所有 worker isolate 后总 CPU）。
- **不要**混用：同一段分析里出现两种口径，读者一定会误读。旧 07-18 profile 报告里的 "main 59.6 % 核" 是含 Non-JS 的进程视角，不是主线程 tid，已在本文档统一改写。

---

## 三、三次压测数据汇总

| 场景 | 报告目录 | QPS | main tid %核 | worker %核 | worker w0/w1 症状 | rss | 通道 | cmd p99 |
|---|---|---:|---:|---:|---|---:|---|---:|
| **e_login_qps** 07-12 | `2026-07-12T…-e_login_qps`（`zone_limit.md` 引述） | ~2.24 k/s | 观察 ≈ 100 %（**无 profile**） | ≈ 50 % 核 | — | 600 MB（SAB）/ 720 MB（postMessage @1.4 k/s） | SAB | — |
| **e_login_qps** 07-18 · 有 profile | `2026-07-18T11-34-e_login_qps/summary.md` | 1.38 k login/s | **46.6 %** | 17.6 / 17.7 % | 对称 | — | postMessage | — |
| **f_realistic_session · run1** | `2026-07-26T06-50-…` | 2977/s | **59.7 %** | 88 / 93 % | **w1 分裂**（详见 §5.5） | 1128 MB | postMessage | 988 ms |
| **f_realistic_session · run2** | `2026-07-26T07-46-…` | 3075/s | **60.5 %** | 90 / 93 % | **w1 分裂**（详见 §5.5） | 1148 MB | SAB | 988 ms |

**"main tid %核"口径统一**：本文所有 tid 数值 = `(main.wall:cpu − :Non JS threads activity:) / window`（见 §2.1）。`f_realistic_session` 报告的 `cycles_total`（bot 循环）不等于 zonesvr cmd QPS——每 cycle 内含多次 rank query。以 `rate(dogsvr_cmd_duration_milliseconds_count{cmdId="20004"}[4m])` 为准，末段稳态 3.0~3.1 k/s。

**07-12 vs 07-18 login 落差**：07-12 观察 tid ≈ 100 % @2.24 k/s，07-18 profile 只有 tid 46.6 % @1.38 k/s。按 QPS 比 1.62× 线性外推 07-12 应 ≈ 75 %，与"接近 100 %"仍有差距。可能原因：(a) 主线程接近饱和后 CPU 曲线超线性上升；(b) 07-12 与 07-18 版本或通道差异；(c) `top` 观测时点比稳态更靠峰。**要坐实"重连风暴 main tid 打满"需要一次重跑 + 同时开 pyroscope。**

---

## 四、场景一：短连接重连风暴（登录 QPS）

_基础数据来自 `example-proj-stress/reports/2026-07-18T11-34-e_login_qps/summary.md` 里的 profile 分析；zone_limit.md 记录 07-12 的 2.24 k/s 上限观测。_

### 4.1 现象

- 07-12 观测：QPS 上限 ≈ 2.2 k connect+login/s，`top` 主线程 tid ≈ 100 % 单核，业务 worker 只跑到 ~50 %。rss 600 MB（SAB） vs 720 MB（postMessage）——SAB 微降 rss，对 QPS 无改善。**无 profile**。
- 07-18 唯一 profile 窗口：1.38 k login/s，main tid 46.6 %、worker 17.6 %/17.7 %。这证明 **hot path 结构性集中在主线程**，但 07-12 → 07-18 的落差不能由这份 profile 直接坐实（见 §三 blockquote）。

### 4.2 主线程 CPU 分布（07-18 窗口，Top 桶，%isolate ÷ 178.87 s）

| 桶 | %isolate | %core |
|---|---:|---:|
| `:(idle):0`（native C++ 期间 V8 抓不到 JS 帧的 fallback） | 31.3 % | 18.7 % |
| `:Non JS threads activity:0`（libuv thread pool + V8 后台 + pyroscope 采样线程；**不含 business worker**，且**独立 tid**，不算主线程 tid %核） | 21.8 % | 13.0 % |
| **主线程 JS 可归因执行** | **45.5 %** | **27.1 %** |
| GC | 1.4 % | 0.9 % |

**主线程 tid = (wall:cpu − Non-JS) / window = (178.87 − 38.95) / 300 = 46.6 % 核**（对齐 `top -H`）。

主线程 JS 执行的 81.37 s 内部按 self time：

- **ws 出站 IO**（`writev` + `writeUtf8String`）合计 16.6 s ≈ 20 % — 全部来自 `tsrpc → sender.sendFrame`。
- **ws 连接关闭链**（`NodeError:500` + `Writable.end` + `closeSocketHandle`）合计 15.5 s ≈ 19 % — 短连接场景的直接税，长连接稳态几乎归零。
- **tsbuffer 编码**（`req2op` + `Varint64` + `_writeInterface` + `finish`）合计 ~14 s ≈ 17 % — tsrpc `encodeApiReturn`。
- `postMessage`（含 logger central + Node worker.postMessage） ≈ 4 s ≈ 5 %。
- 业务代码（cmd_handler、`_onApiCall`）self time 几乎不可见——主线程只做网关，业务下沉到 worker。

### 4.3 判断

- **主线程是 login 场景的最集中 hot path**（ws sendFrame native writev + connection close 链 + tsrpc encode 全在主线程）。这些是硬开销，改不动 → 需要 **水平扩展**（多进程 / 多 zonesvr 实例）或 **降短连开销**（tls session resumption / http upgrade 复用、更粗粒度的 tsrpc 打包）。
- Worker 在此场景余量 >70 %，堆 worker 数**没意义**。
- SAB 对本场景 QPS 无杠杆：主线程 postMessage self ≈ 4 s / 178.87 s = 2.2 %，换 SAB 最多省这部分，还大概率被 SAB 的 fixed cost 吃掉（见 §5.7）。

---

## 五、场景二：长连接稳态业务（rank 查询）

_数据窗口：2026-07-26T06:50–06:55（run1 · postMessage） / 2026-07-26T07:46–07:51（run2 · SAB），5 min 稳态。_

### 5.1 现象

Prometheus 稳态 metric（run2 SAB，`rate(...[4m])@t=07:51`）：

| 指标 | 值 |
|---|---:|
| `dogsvr_cmd_duration_milliseconds` `cmdId=20004`（ZONE_QUERY_RANK_LIST）QPS | **3075/s** |
| 同 cmd p50 / p95 / p99 | 202 ms / — / **988 ms** |
| `dogsvr_cmd_duration_milliseconds` `cmdId=20005`（ZONE_HEARTBEAT）QPS | 26/s（p99 48 ms） |
| worker0 cmd count rate | 1549/s（`worker_cmd_hdl` p99 **36 ms**） |
| worker1 cmd count rate | 1547/s（`worker_cmd_hdl` p99 **992 ms**） |
| `dogsvr_thread_cpu_utilization` main | **0.63** |
| worker0 / worker1 | **0.90 / 0.93** |
| `dogsvr_worker_elu_utilization` w0 / w1 | **0.92 / 0.96** |
| `dogsvr_worker_heap_used_bytes` 峰值 w0 / w1 | 156 MB / **224 MB** |
| `dogsvr_worker_gc_duration_seconds` rate w0 / w1 | 0.04 / **0.09** s/s |
| `mongo_op_duration_milliseconds` `role_coll.find` QPS | 6129/s（p50 15 ms / p95 421 ms / **p99 484 ms**） |
| `redis_op_duration_milliseconds` `zRangeWithScores` QPS | 3061/s（p50 18 ms / p99 99 ms） |
| `redis_op_duration_milliseconds` `zRevRank` QPS | 3060/s（p50 16 ms / p99 99 ms） |
| `dogsvr_process_rss_bytes` zonesvr | 1148 MB |
| SAB hit ratio | 99.998 % |
| txn pending | 0 |

对照 run1（postMessage）：QPS 2977、main 60 %、worker 88 %/93 %、rss 1128 MB、Mongo p99 485 ms — **结构基本一致**。SAB 带来的差别 <3.3 %，在采样噪声范围内。

### 5.2 主线程 CPU 分布（run2 wall:cpu，%isolate ÷ 424.24 s）

| 桶 | %isolate | 备注 |
|---|---:|---|
| `:Non JS threads activity:0` | 54.7 % | libuv thread pool + V8 后台 + pyroscope 采样线程，**不含 business worker isolate** |
| `:(idle):0` | 16.8 % | 主 JS 线程 native 期间 V8 fallback |
| `:writev:0` | 4.2 % | ws 出站 |
| tsbuffer `req2op` + `Varint64` + `_writeInterface` + `finish` | ~6 % | tsrpc encode |
| `sab_ring.resetIndexes:46` | 2.1 % | logger central + IPC 触发的 seqlock；追父链见 §5.3 结尾 |
| `:Garbage Collection:0` | 1.4 % | — |

主线程 tid 口径（`(wall:cpu − Non-JS) / window`）= (424.24 − 232.06) / 317.4 = **60.5 % 核**，对齐用户观测的 64 %（tid 采样波动几个点在噪声内）。**主线程离饱和还有余量**。

### 5.3 Worker CPU 分布（run2 w0 wall:cpu，%isolate ÷ 275.6 s）

| 桶 | %isolate | 说明 |
|---|---:|---|
| `cmd_handler.js:144` = `ZONE_QUERY_RANK_LIST` handler（total 44 s，self 25 s） | 17.9 %（self ~9 %） | handler 自身 async 帧调度 + JSON.parse/stringify + Promise 微任务 |
| BSON `serializeInto` + `deserializeObject` | 12.8 % | mongodb driver 编解码 request/response（含 filter encode + doc decode） |
| Redis RESP `#decodeBlobString` | 8.2 % | Redis 返回大量 blob，每次 decode |
| `:writeBuffer:0`（native socket write） | 7.3 % | Redis + Mongo socket 写 |
| `:(idle):0` | 7.0 % | native fallback |
| `:Garbage Collection:0` | 5.5 % | w1 稳态到 10.3 % |
| `sab_ring.resetIndexes:46` | 3.1 % | 日志 SAB writer + main-side msg channel |
| `logger_proxy.debug` → `pino.LOG` → `sab_writer.write` | ~5 % | 每 handler 入口 `log.debug({req}, ...)`，`log.level="trace"` |
| OTel `hashAttributes` | 1.4 % | metric label 哈希 |

追父链定位 `sab_ring.resetIndexes` 的来源（`run2_w0`，8.57 s total）：

```
4.478s  sab_line.tryWrite ← logger central sab_writer.write ← pino.LOG ← logger_proxy.debug ← cmd_handler:144
3.676s  sab_msg.trySend  ← worker_thread sendToMain ← respondCmd（响应回传主线程）
```

即 worker 上的 SAB 写入 ~50 % 来自 **trace 级日志**、~50 % 来自 **cmd 结果回传主线程**。前者可以直接关。

### 5.4 QPS 与远端依赖的对应

- 每次 rank query 平均触发：
  - `role_coll.find` × 2 （3075 × 2 ≈ 6150，实测 6129 QPS ✓）
    - 一次是查询请求发起者自己的 role
    - 一次是 `batchQueryRoleBriefInfo` 拉排行榜上其他人的 brief（TbRank.count=100）
  - `redis.zRangeWithScores` × 1 （3061 QPS ✓）
  - `redis.zRevRank` × 1 （3060 QPS ✓）
- **Mongo `find` p99 484 ms** 是 cmd p99 988 ms 的**主要因子**：串行 2 次 find，加上最后 batch 大 doc decode 与网络往返，尾延几乎全被 Mongo 占了。Redis 侧 p99 99 ms 稳定。
- 主 pcu 参照（zone_limit.md）：全服 156 w PCU、单机 1~1.5 k PCU 主分布、峰值 2 k。当前 3.1 k rank/s ≈ 单机 1.5 k PCU 每人每 500 ms 一次的极端负载模型；实际业务节奏下 headroom 更大。

### 5.5 Worker 之间的负载不均

请求分布 w0:w1 = 1549:1547（几乎完美 50/50），但表现差异悬殊：

| 指标 | w0 稳态 | w1 稳态 | 倍数 |
|---|---:|---:|---:|
| `worker_cmd_hdl` p50 | 8 ms | **595 ms** | 74× |
| `worker_cmd_hdl` p99 | 36 ms | **992 ms** | 27× |
| `worker_cmd_hdl_pending` peak | 181 | **989** | 5.5× |
| **mongo `role_coll.find` p99** | **9 ms** | **490 ms** | 55× |
| **redis `zRange` p99** | **10 ms** | **99 ms** | 10× |
| **redis `zRevRank` p99** | **9 ms** | **128 ms** | 14× |
| **redis `zScore` / `eval` / `set` p99** | ~9 ms | ~99 ms | ~11× |
| mongo `find` 累计请求数 | 990 443 | 990 578 | 1.0× |
| heap peak / min | 156 / 29 MB | 224 / 56 MB | 1.4× |
| minor GC 次数/s | 9.0 | 8.0 | 0.9× |
| minor GC 时间/s | 0.041 | 0.084 | 2.0× |
| wall:cpu total | 275.6 s | 285.2 s | 1.03× |
| ELU peak | 1.00 | 1.00 | — |

#### 5.5.1 关键辨别：mongo 本身没变慢

初读像是"w1 上 mongo 变慢"，其实不是。**w0 稳态 mongo p99 = 9 ms** 就是这台 mongo server 在同样 QPS（3 k+ find/s）下**真实**的 find.toArray 延迟——服务端、网络、索引 (`openId+zoneId`) 都是健康的。同一 mongo server 同一份代码不会突然只对 w1 变慢 50 倍。

w1 报出来的 492 ms 是 `mongo_proxy.timedColl` 里包在 `await coll.find(...)` 外面的**墙钟计时**：

```
duration_recorded = wire_time_to_mongo + event_loop_tick_lag
```

`event_loop_tick_lag` = mongo driver 收到 TCP response、resolve promise 之后，v8 microtask queue 里排着的几百个 handler 全跑完，才轮到我们 handler 的 `.then` 继续执行。**metric 记的是"发起请求到 continuation 真正执行"的时长，不是 mongo server 处理时长**。

**加分证据**：redis 五种 op 全部同步长尾（9~10 ms → 99~128 ms）。如果是 mongo server / driver 自身问题，redis 不会跟着长尾；如果是 handler CPU 变慢，pending 不会积压到 ~850。**唯一能同时解释所有观测的是 event loop tick lag**。真正衡量下游健康度的是 w0 那一列。

#### 5.5.2 那 "w1 事件循环拥堵" 又是为什么？

看 pending 的时间演化（15s step，单位 = 排队中的 handler 数）：

```
   0s  15s  30s  45s  60s  75s  90s 105s ...
w0  0  159   12   17    5   17    7    1  ...  持续低位 <30
w1  0   79  465  672  969  971  946  926  ...  60s 后进稳态 ~850
```

**pending 是从 15s → 60s 直线拉升，60s 后进入稳态 ~850**，之后 4 min 不涨不降——**不是"慢累积到爆炸"，是"启动窗口内就分裂到另一个稳态"**。

分两层看：

**(a) 启动窗口 15~30 s 内 w1 为什么短暂落后？**（真正的 trigger）

Ramp 阶段（60 s 内 QPS 0 → 3 k/s）任何微小的 service-rate 差异都会让 pending 分裂。可能的扰动源（**都属于必然会发生的物理事实，无法完全消除**）：

- **V8 tier-up 时机**：同一函数在两个独立 isolate 上被 tier-up 到 TurboFan 的时机随机（首次触发条件与该 isolate 内部的调用计数直接相关），晚 tier-up 那侧慢 30~100 ms。
- **mongo client pool 冷启动**：每个 worker 独立 MongoClient，pool 内 socket 首次 TCP + auth handshake，两侧完成时刻不同。首个请求需要等 pool 上第一条连接就绪。
- **首次 GC 时机**：初始 heap 到达 minor GC 阈值的时点不同；一侧碰巧在 ramp 中段首次 GC 就多切几十 ms。
- **内核调度 / pyroscope profiler 冷启动**：一侧初始化任务多切一次 CPU，或首次 pyroscope 采样恰好落在关键 handler 中段。

任一因素在这几秒内让 w1 pending 冲到某个临界（约 200 深，见 5.5.1 表），进入 (b)。

**(b) 一旦落后为什么再也回不来？**（RoundRobin 的 bistable 性质）

`dogsvr/dist/main_thread/lb.js` 默认 `RoundRobinLB`（zonesvr 未配 `lbStrategy`），不看下游负载，2 worker 严格 1:1 交替。当 arrival = 3 k/s/worker 时：

- **w0 侧**：service_rate > arrival_rate，pending 稳态 <30 且能吸收小扰动 ← 浅队列稳态。
- **w1 侧**：一旦 pending 冲到几百，队列里的每个 handler 都要等前面一堆完成才能触发 continuation，handler 的**有效** service time 被拉长（await 里都是 tick lag 而非 CPU 时间）。此时 service_rate 恰好被拉低到 ≈ arrival_rate 的水平 → pending 保持在这个高度不涨也不降。看起来"稳定"，其实是被拉长的 handler service time 与 arrival 恰好平衡 ← 深队列稳态。
- **RoundRobin 无反馈机制**：新请求仍以 1:1 节奏塞给 w1，pending 永远回不到 0。LeastLoad 会把 arrival 从 w1 挪开，让 w1 只出不进，直到排空。

这是 **bistable dynamical system**：两个稳定平衡点（浅队列 / 深队列），初始扰动决定进哪一个，之间没有平滑过渡。

#### 5.5.3 heap / GC 差异是被拉高的，不是根因

- w1 heap 稳态 224 MB vs w0 156 MB：主要是 **队列里有 ~850 个 pending handler，每个持有 `reqMsg.body` + 若干 mongo response 引用**，object 生命周期被拉长几百倍 → new generation 里熬过 minor GC 的 object 变多 → heap 抬高。因果反过来。
- w1 minor GC 时间是 w0 的 2 倍（84 ms/s vs 41 ms/s）：与 heap 增大同源。但每次 GC 就几毫秒，全 5 min 累计 ~13 s，不足以自己解释 800 深的队列。是**放大因子**，不是**根因**。

#### 5.5.4 排除的候选

- **V8 JIT tier 差异（长期）**：wall:cpu 差 +3 %、wall:wall 差 +5 %，这么小的算力差异不可能自己造成 handler service time 拉长 50 倍。JIT 只可能是问题 (a) 里"启动窗口的初始扰动源之一"，不是稳态原因。
- **pyroscope 采样干扰**：两侧都开采样，不能解释单侧现象。
- **mongo driver connection pool 卡死**：如果 pool 有连接挂起，`mongo_op_duration` 会长但 pending 不一定深；且 pool 卡了会看到 accumulated error / 超时。**且 redis 也跟着长尾，redis client 是独立 socket，不可能被 mongo pool 影响**。

#### 5.5.5 验证与修复顺序

1. **换 `lbStrategy: leastLoad`（`lb.js:30-42` 已实现，一行配置改动）**：分裂发生瞬间就有主动纠偏——见 5.5.6 详细分析。**必须配合下一条一起做，单独换有风险**。
2. **worker 数从 2 → 4**：LeastLoad 只在"单 worker 有明显服务能力冗余"时安全。当前 worker 已 90 %+ 单核，冗余薄，单换 LeastLoad 可能把"一侧慢"扩散成"两侧都慢"（w0 承接了 w1 挪出的 arrival、也逼近临界）。加 worker 数是让 LeastLoad 有余量可用的前提。分裂到"深队列稳态"的概率也是初始扰动的函数；worker 越多，每 worker arrival 越少，越难跨过临界。
3. **加 pending 告警**：`dogsvr_worker_cmd_hdl_pending > 200` 报警——一旦分裂，越早看到越好。
4. **可选：ramp 期慢起**（当前 60 s ramp 到 3 k/s，改成 120 s + 前半段线性慢一些）：把启动窗口的扰动源与稳态 QPS 拉开，减小 trigger 概率。仅辅助手段。

#### 5.5.6 LeastLoad 能识别 tick lag 吗

代码见 `dogsvr/dist/main_thread/lb.js:30-42` + `main_thread/index.js:99-134`：

```
selectWorkerIndex()          → this.pending.indexOf(Math.min(...))
onMessageSent(i)             → pending[i]++          (发给 worker 时)
onMessageResolved(i)         → pending[i]--          (响应回到主线程时)
```

主线程 `LeastLoadLB.pending[i]` = **已发给 worker i、还没收到响应的 outstanding txn 数**，覆盖 `[主线程 send] → [worker 收] → [handler 执行] → [响应回主线程]` 整段。这个 counter **间接**反映 tick lag：

- w1 tick lag 高 → handler continuation 执行晚 → 响应回主线程晚 → `pending[1]` 数字变大 → 下次 selectWorker 跳过 w1
- **有反馈**（是效果的直接读数，不是预测）
- **滞后**（要等 pending 涨起来才纠偏，中间隔了一个 SAB / postMessage 通道往返 + worker 内部 tick）

**核心价值：分裂事件发生瞬间就能截流。** 场景：w1 在 t=1 s 因为 GC 停顿 80 ms，期间 arrival 3 k/s：

- **RoundRobin**：这 80 ms 内继续 1:1 交替给 w1 塞 ~120 个新请求，pending 从 5 涨到 125
- **LeastLoad**：GC 一开始 pending[1] 就领先，接下来的请求**全部投给 w0**，pending[1] 尖峰能压到 ~5

这是 LeastLoad 相对 RoundRobin 最关键的优势——**不是"识别 tick lag 有多大"，而是"限制 tick lag 造成的 pending 尖峰高度，防止跨过 bistable 系统的临界"**。

**局限**：

- 主线程 `pending[i]` 与 worker 内部真正的 `worker_cmd_hdl_pending` **不是同一个东西**——中间隔了通道 buffer。若 w1 已经卡但通道 buffer 还没满，主线程感知有延迟。
- **tie-break 用 `indexOf(min)` 命中第一个最小值**：稳态 `pending=[0,0]` 时永远选 w0。极低 QPS 时会有短暂"全塞 w0" 窗口，通常无害。
- **当 w1 长期慢**：LeastLoad 会持续把 arrival 挪向 w0，稳态两侧 pending 趋近相等但 QPS 分布严重倾斜。若 w0 也接近饱和（本次 90 %+ 单核就是这种情况），可能把"一侧慢"扩散成"两侧都慢"。**LeastLoad 只在服务能力冗余明显（≥30 % 单 worker 余量）时安全，因此第 2 条加 worker 数是前提**。
- **不能预防 GC / tier-up 本身发生**，只能限制它造成的 pending 尖峰。

**更彻底的方案（不在当前修复范围内）**：让 LB 直接看 worker 端上报的 event loop lag（`perf_hooks.monitorEventLoopDelay`）而非 outstanding txn count——目前 `dogsvr_worker_eventloop_lag_seconds` histogram 在本次窗口 no data（上报路径可能断了或没配），是独立的观测缺口。

### 5.6 判断

- **表面瓶颈**（`worker_cmd_hdl` p99 992 ms / mongo p99 484 ms）是 **event loop 拥堵的 readout**——见 §5.5。**LB 修复后大部分数字应显著回落**。
- **修复后的真实瓶颈**（预估）：worker BSON + RESP + handler + GC 编解码 CPU（90 %+）→ 堆 worker 数是主要杠杆。
- **主线程 tid 60 % 仍有余量**，加 worker 数到 4 之前主线程不会先饱和；到 8 worker 时（QPS ~10 k rank/s 估算）主线程会开始成为瓶颈。
- SAB 在本场景不占优势（见 §5.7）。

---

### 5.7 SAB 为什么没跑赢 postMessage

**观察**：run1 postMessage vs run2 SAB，QPS 2977 → 3075（+3.3 %），p99 988 → 988 ms 持平，进程 wall:cpu total 892 s → 985 s（**+10 %**），rss 1128 MB → 1148 MB。SAB 换来的一点吞吐几乎正好被自己的 CPU 开销吃掉。

#### 5.7.1 IPC 每 op 成本量化

从 profile 抽出 IPC 相关的 self time，按 QPS × 300s 摊到"每消息"：

| 组件 | run1 postMessage μs/op | run2 SAB μs/op |
|---|---:|---:|
| main `:postMessage:0` | **8.82** | 0 |
| main `sab_ring.resetIndexes` | 0 | **9.72** |
| main `sab_msg.tryRead/Write/pumpOnce` | 0 | 3.38 |
| **main IPC 合计** | **8.82** | **13.10** |
| w0 IPC 合计 | 7.33 | 11.33 |
| w1 IPC 合计 | 7.30 | 8.53 |

结论：**SAB 版本每 op 主线程侧比 postMessage 多花 ~4 μs、worker 侧多 1~4 μs**。放到 3 k/s × 300 s = 90 万次消息上，累计 3~4 秒额外 CPU，正好落在实测 wall:cpu +93 s 的量级里（本轮还叠加了别的差异，但方向对得上）。

#### 5.7.2 实现层面：当前 SAB 的 fixed cost 项

看 `dogsvr/dist/common/sab_msg.js`：

1. **head 走 JSON.stringify + JSON.parse**（`sab_msg.js:22, 161`）——每消息一次 stringify + reader 侧一次 parse。head 里 txnId/cmdId/gid/zoneId/openId/traceId 加起来 100~200 B UTF-8。**postMessage 走 V8 structured clone（C++ 实现），对小对象比 JSON 路径快**。
2. **`sab_ring.resetIndexes` 是 hot path，不是 rare event**（`sab_msg.js:32-36`）——只要 ring 排空后 `write === read && write !== 0` 就 reset 一次。稳态下 write/read 交替追赶，几乎每消息触发。`resetIndexes` 内 2 次 `Atomics.add(SEQ)` + 2 次 `Atomics.store` + `Atomics.notify`，都是内存屏障级操作，profile 里占 main isolate ~9.7 μs/op，是 IPC 层最大的 self time。
3. **每 op 5~6 次 Atomics 操作**——`readState` seqlock 3 次 load、`commitWrite` 1 次 store + `notify`。单次纳秒级但会累加，且带来 CPU pipeline / cache line invalidation。
4. **worker 侧 pump 通过 `setImmediate` 循环**（`sab_msg.js:102`）——`pumpOnce` 找到 data 后走 `setImmediate(loopBound)` 回下一 tick 再处理。每次都要过 Node 的 Immediate queue，高频消息下累积可见。
5. **`waitAsync` 空转唤醒经 Promise `.then`**（`sab_msg.js:116-126`）——微任务本身几百纳秒开销，未必比 postMessage 的 uv_async_send + wake 路径短。

#### 5.7.3 场景层面：为什么这些 fixed cost 会显现

1. **IPC 不是本场景瓶颈**：worker 侧 IPC 相关约 5 % CPU，即便省到 0，QPS 上限也只 +5 %。SAB 实现的 fixed cost 超过它避开的 postMessage clone 成本 → 净成本反而升。
2. **消息 body 很小**（head ~150 B + body JSON ~1~2 KB）：SAB 的经典优势是"避开 structured clone 大对象的拷贝"。clone 成本约 O(body size)，小 body 下也就几 μs。SAB 免掉 clone 但换来 JSON.stringify(head) + utf8 encode/decode(body) + Atomics 屏障，**对小 body 反而更贵**。
3. **handler service time ~300 μs**（每 rank query 4 次远端往返主导）：IPC 8~13 μs 只占 handler wall time 的 3~4 %，几乎看不到。
4. **3 k QPS 不算高频**（每 333 μs 一次消息）：Node 的 uv_async_send + wake 路径吸收得住，postMessage 的唤醒开销没到峰值。

#### 5.7.4 分层判断

| 层次 | 是否是 SAB 目前"无改善"的原因 |
|---|---|
| **实现问题**——head JSON、resetIndexes 每消息触发、Atomics 5+ 次、setImmediate 反复投递 | **主要原因**。SAB 实现每消息 fixed cost ~10 μs（主线程侧）已经超过它替代的 postMessage clone |
| **场景问题**——小 body、handler 主导 wall time、IPC 只占 5 % CPU、3 k QPS 中等频率 | **放大原因**。即使实现更优，本场景也不会让 SAB 大幅赢过；只是不至于反输 |
| **组合效应**——用户预期"换 SAB 提 QPS"，但 IPC 优化的边际本来就 <5 %，SAB fixed cost 又把这 5 % 吃掉 | 净差异 -3 %~+3 %，落在采样噪声内 |

#### 5.7.5 SAB 什么时候真的赢

- **body 可以 zero-copy 传递**：生产者直接把数据**原地**写在共享 SAB 里，消费者拿到同一段内存的 view，双方都不做 encode / copy——这是 SAB 的机制优势所在。当前 sab_msg 实现**不是**这种模式：string body 走 UTF-16→UTF-8 encode（`sab_msg.js:57`），binary body 走 memcpy（`sab_msg.js:54`），无论 body 多大都要付一次 per-byte 成本。所以本条只有在改造成"零拷贝 view"模式后才成立
- **消息频率极高**（比如数万 /s，具体阈值未测）：postMessage 的 wake + clone 才会压倒 SAB 的 poll
- **对延迟敏感**（想避开 event loop 一次唤醒的抖动）：SAB waitAsync + Promise 可做微秒级唤醒
- **worker CPU 不是瓶颈**（IPC 占比高）：只有 IPC 是主开销时 SAB 才有杠杆

> **未验证的关系**：SAB vs postMessage 的 crossover（body size / QPS / clone 深度等维度）**当前没有 benchmark 数据**支持——需单独跑一次微基准（body 从 100 B 扫到 1 MB，string 和 Buffer 两种，测每消息 μs）才能给出精确阈值。上面各条只是"何种条件下 SAB 有机会赢"的定性判断。

当前 rank query 场景 4 条都不满足。login storm 场景（4.2）主线程侧 postMessage self ~4 s / 178.87 s = 2.2 %，SAB 的 fixed cost 也大概率吃掉这点节省——**除非先做 5.7.6 的实现优化，否则 SAB 在 login storm 场景大概率也不赢**。

#### 5.7.6 可以动的实现优化方向（不承诺，仅列方向）

如果想让 SAB 在这类小 body 场景也能赢过 postMessage：

1. **head 用定长二进制 field**（cmdId u16 + txnId u32 + gid u64 + traceId 16 B …）取代 JSON——预估省 2~4 μs/op
2. **稳态不 resetIndexes**：ring drain 后不必 reset，改成 write/read 无限增长 + 模运算——直接抹掉当前最大的 self-time 项 ~10 μs/op
3. **worker 侧 pumpOnce 用 while 消化连续可读消息**，而不是每次 setImmediate 回到 event loop
4. **head + body 合并写**：合并成一次 struct 写入（一次 length prefix + 一次 UTF-8 encode），减少 `dv.setUint32` / `bufView.write` 调用次数

做完这些之后 SAB 应该能在小 body 场景也稳定跑赢 postMessage 一小截。参见 dogsvr 仓库 SAB 传输层的 hot path 零分配约束（`dogsvr/src/common/sab_*.ts`）。

---

## 六、分场景是否合理？—— 分析

**结论：合理。** 两个场景走完全不同的 hot path，指标分布相反：

| 维度 | 短连接重连风暴 | 长连接稳态业务 |
|---|---|---|
| 主线程 tid %核 | 07-12 观察 ≈ 100 % @2.24 k/s；07-18 profile 46.6 % @1.38 k/s | 60.5 % @3.07 k/s |
| Worker %核 | ~18 % | ~93 % |
| Worker ELU | 未测（QPS 上限已 main-bound） | 0.92 / 0.96 |
| CPU 大头 | ws sendFrame / connection close / tsbuffer encode（主线程） | BSON + RESP + handler + GC（worker） |
| 主要故障模式 | 主线程被 native writev / stream close 抢 CPU | RoundRobin + bistable 分裂锁定 event loop 拥堵 |
| 扩容杠杆 | 多进程 / 多实例（水平） | worker 数（垂直） |
| SAB 收益 | 微降 rss，QPS 无变化 | +3 % QPS（进程 CPU 反而 +10 %，见 §5.7） |

补充测试建议（本次未覆盖，作为遗留观测缺口，与 §九互补）：

- **第三条 hot path：battle 场景**（ZONE_START_BATTLE + battlesvr tick + Matter 物理）。本次 bot `weightBattle=0` 关闭，battlesvr CPU 分布未知。
- **混合场景**（少量登录 + 大量长连接稳态请求）。当前两个场景是纯极端，实际业务是混合的；主线程 + worker 同时受压时 SAB 收益、tid 曲线可能非线性。
- **不均衡 worker 请求分布**。当前 50/50 请求分布掩盖了 RoundRobin 的 bistable 分裂问题需要"启动窗口小扰动"触发的现象；若能设计一个 bot 阶梯发压，可以稳定复现分裂并观察 LeastLoad 修复效果。

---

## 七、容量预估

_下面数字都基于"单机 + 当前 dogsvr / example-proj 配置 + 当前压侧混部"的相对参考，不做生产容量承诺。_

### 7.1 zonesvr 单机上限（当前配置：1 main + 2 worker）

| 场景 | 当前实测 | 主要卡点 | 加 worker 后估算 | 加实例后估算 |
|---|---:|---|---|---|
| 短连接登录 | 2.2 k login/s | 主线程 tid ≈ 100 % | 无变化（主线程已满，与 worker 数无关） | 线性堆实例 |
| rank 查询稳态 | 3.1 k rank/s | worker 93 % + w1 bistable 分裂 | LB 换 leastLoad + 4 worker → ~5.5 k rank/s；8 worker → ~10 k rank/s（主线程 tid 估算 90 %+ 时先饱和） | 若加 role/rank 缓存降 mongo/redis QPS，单机再 +50 %（估） |

**估算的假设**（未验证）：worker 数线性外推假设 mongo server (`role_coll.find` 目前真实 p99 9 ms) 与 redis (p99 ~10 ms) 在 QPS 翻倍后仍有余量。若后端也进入拥堵，实际上限会低于此估算。

### 7.2 单实例 rss

| 场景 | rss | 备注 |
|---|---:|---|
| 短连接稳态 @1.4 k/s postMessage | 720 MB | 07-12 观察，`zone_limit.md` 引述 |
| 短连接稳态 @2.2 k/s SAB | 600 MB | 07-12 观察，SAB 微降 rss |
| 长连接稳态 @3.0 k/s postMessage | 1128 MB | run1 |
| 长连接稳态 @3.1 k/s SAB | 1148 MB | run2 |

长连接场景 rss 主要来自 worker heap（w1 稳态 224 MB，见 §5.5）；bistable 分裂被修复后 w1 heap 应回落到 w0 量级（~150 MB）。加 worker 数 rss 大致线性上升——8 worker 估 ≈ 2 GB。

### 7.3 与业务参照数据的对齐（`zone_limit.md`）

- `ZoneRegistLimit.max_register_num = 41 000`，实际 zone 上限 4 w~6 w。
- awx 单物理机 PCU 主分布 1~1.5 k，峰值 2 k。
- 当前 zonesvr rank 查询 3.1 k/s ≈ 3 k PCU 每人每秒各 1 次；实际业务节奏下承载 ≥ 2 k PCU 是安全的。
- **结论**：当前 zonesvr 单实例可以稳定承载 1 zone 上限（约 4 w~6 w 注册, 1~2 k PCU），主线程与 worker 都有余量；若要接近 max_register_num 且日活集中，建议加到 4 worker + LeastLoad LB。

---

## 八、建议的动作（优先级）

### P0（零风险 / 一步生效）

1. **压测环境 `log.level` 从 trace 降到 info**（`example-proj/src/servers/zonesvr/{main,worker}_thread_config.json`）。
   - 依据：本次 5 min 日志输出 323 MB，worker profile 里 `logger_proxy.debug` → `pino.LOG` → `sab_writer.write` 链占 ~5 % worker CPU；每个 handler 入口的 `log.debug({req}, ...)` 都会走完整 pino → SAB writer 链。
   - 收益：省 ~5 % worker CPU + 60 %+ 日志盘 IO。生产 log.level 应本来就是 info/warn，本条只影响压测环境。

### P1（修复 §5.5 bistable 分裂 · 需组合执行）

2. **换 `lbStrategy: leastLoad`** 且 **worker 数 2 → 4**（`example-proj/src/servers/zonesvr/main_thread_config.json`）。
   - 依据：见 §5.5.5 / §5.5.6。单独换 LB 有把"一侧慢"扩散成"两侧都慢"的风险，因为当前 worker 已 90 %+ 单核；必须先加 worker 数（每 worker arrival 减半）再换 LB。
   - 收益：预期 cmd p99 从 992 ms 大幅回落（w1 分裂消除），QPS 上限升到 ~5.5 k rank/s 量级。
   - 验证：跑 f_realistic_session 对照，检查 w0/w1 的 `worker_cmd_hdl_pending` 是否对称（都 <30）、`mongo_op_duration` p99 是否降到 ~10 ms 量级。

3. **加 Grafana alert**：`dogsvr_worker_cmd_hdl_pending > 200` 报警。当前 stress dashboard 里这个 series 无阈值。分裂事件早发现越好。

### P2（进一步降 mongo/redis QPS）

4. **rank list 短 TTL 缓存**（10~30 s）。rank 数据对秒级实时性不敏感，缓存能同时降 Redis QPS（3 k → ~百 /s）、Mongo find QPS（6 k → 数百/s）、worker BSON/RESP decode CPU。
5. **`batchQueryRoleBriefInfo` 用 `$in` + projection**，只拿 gid/name，缩小 doc 体积→ 降 BSON decode CPU + 网络。
6. **role 单查缓存**（openId+zoneId → role）：rank 场景 role 相对静态。
7. **索引审查**：确认 `openId+zoneId` 复合索引在 mongo 上确实被使用（`explain()`）。当前 w0 稳态 p99 9 ms 说明索引很可能已生效，此条为兜底检查。

### P3（观测缺口 / 中长期）

8. **`dogsvr_worker_eventloop_lag_seconds` histogram 上报路径**：本次窗口 no data，`perf_hooks.monitorEventLoopDelay` 采样可能没配或上报断了。这是识别 tick lag 最直接的 metric，比 pending 更精确，需要恢复。
9. **补 07-12 login storm 的 profile**：重跑一次 login storm 并同时开 pyroscope 采样，坐实 "main tid 打满" 定量结论（见 §四 caveat）。
10. **battle 场景测试**：`weightBattle > 0` 跑一次混合负载，观察 battlesvr Matter tick + zonesvr 转发 CPU 分布（第三条 hot path）。
11. **SAB 实现层优化**（如 §5.7.6，可选）：head 定长二进制、稳态不 resetIndexes、worker pumpOnce 用 while、head+body 合并写。做完后 SAB 应能在小 body 场景稳定跑赢 postMessage。仅在确定 IPC 是瓶颈时才值得动。

---

## 九、遗留问题

- **w0/w1 分裂尚未通过实验验证**：分析定位到 RoundRobin + 启动窗口小扰动触发 bistable 分裂（§5.5）。需按 §8-P1 方案跑对照实验坐实。
- **07-12 login storm 的 profile 缺失**：2.24 k/s 打满 main tid 的定量结论只有 `top` 观测，无 pyroscope 支持。
- **`dogsvr_worker_eventloop_lag_seconds` 无数据**：本次窗口该 histogram 无采样，无法直接观测 tick lag。上报路径需排查。
- **battle 场景未测**：bot 侧 `weightBattle=0` 关闭。
- **混合场景（登录 + 稳态业务）未测**：主线程 + worker 同时受压时 SAB 收益、tid 曲线可能非线性。
- **主 isolate `Non JS threads activity` 内部结构未拆**：占 wall:cpu 55 %，但 libuv thread pool 具体是 fs / dns / crypto 里的哪些 op 目前没细拆。想进一步优化主线程需要下一层观测（`node:trace_events` 或 pyroscope 加 libuv 专项）。

---

## 附：Prometheus 查询窗口

- run1（postMessage）: unix `1785048632–1785048950`（2026-07-26 06:50:32–06:55:50 UTC）
- run2（SAB）: unix `1785051965–1785052282`（2026-07-26 07:46:05–07:51:22 UTC）
- login 07-18 profile: 2026-07-18 11:34:35–11:39:35 UTC（对应 `reports/2026-07-18T11-34-e_login_qps/`）

Pyroscope 采样命令与百分比口径规范：本次分析已内联关键口径于 §2。
