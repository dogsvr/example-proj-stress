# Analysis

跨压测、跨观测源（Prometheus + Pyroscope + 日志）的容量/瓶颈**分析归档**。与 `reports/` 目录的区别：

- `reports/<run>/summary.md` = 单次压测 run 的**自动产出** summary（bot fleet 自己写）
- `analysis/*.md` = 跨多次 run + 多观测源的**手写分析**，回答"为什么"、给出优化方向

文件名约定：`YYYY-MM-DD-<subject>.md`（日期是分析完成日）。**分析随代码演化会过期**——日期让读者立刻知道对应哪个时点的仓库状态。做同一主题的复测/续测，另开一份新日期的文档，不改旧的。

`scripts/` 放分析用的取数脚本（只用 Python 标准库），用法见脚本开头的说明和引用它的分析文档。

## 索引

| 日期 | 主题 | 主要结论 |
|---|---|---|
| 2026-07-26 | [zonesvr 容量分析](2026-07-26-zonesvr-capacity.md) | 短连接重连风暴 vs 长连接稳态两条 hot path；rank 场景 cmd p99 长尾是 event loop tick lag readout 而非 mongo 真慢；RoundRobin + bistable 分裂锁定 w1；SAB 相对 postMessage 净差异 <4 %，wall:cpu 反而 +10 %；建议 LeastLoad LB + 加 worker 数（2026-10 已更正部分推论，见下一行）。 |
| 2026-10-17 | [zonesvr leastLoad 修复与 2026-10 性能复测](2026-10-17-zonesvr-lb-fix.md) | 分裂是闭环压测 + 轮询下的对称破缺；dogsvr 默认 LB 改为 leastLoad 后两侧在途 15 / 874 → 440 / 440，QPS +6.2 %；CPU 上涨来自吞吐，每次请求 CPU −2.6 %；SAB 优化（单独完成，不在 lb fix 内）复测胜过 postMessage：QPS +2.5 %、每次请求 CPU −3.5 %；相对 07-26 QPS +14.2 %；Pyroscope 整段总量有 ±10 % 噪声，CPU 绝对值以 /proc 为准。 |
| 2026-10-19 | [zonesvr worker 监管（dogsvr a762c3d）验证与 2026-10-18 性能复测](2026-10-19-zonesvr-worker-supervision.md) | 稳态性能与 10-17 无可测差异（QPS +0.07 %、每次请求 CPU +0.16 %，均在噪声内）；热更新期间 > 500 ms 的请求从 894 / 850 降为 0，代价是热更新多约 1 s、启动多约 0.5 s；崩溃 / 启动故障 / 热更新中止的真实进程故障注入均符合设计，0 事务超时；证实 4 个缺陷（allAtOnce 报错槽位错、重复触发回复不可信、排空可能永久挂起、静默丢弃拖满排空超时），rolling 中止后版本混杂列为待决策的可优化项；负载期间每个新建 worker 约 12 MB RSS 到空闲才回收；battlesvr 热更新会断开所有进行中的对战；bot 集群模式指标只剩一个分片、100 bot 的 B / D 场景 bot 会卡死。 |
