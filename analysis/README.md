# Analysis

跨压测、跨观测源（Prometheus + Pyroscope + 日志）的容量/瓶颈**分析归档**。与 `reports/` 目录的区别：

- `reports/<run>/summary.md` = 单次压测 run 的**自动产出** summary（bot fleet 自己写）
- `analysis/*.md` = 跨多次 run + 多观测源的**手写分析**，回答"为什么"、给出优化方向

文件名约定：`YYYY-MM-DD-<subject>.md`（日期是分析完成日）。**分析随代码演化会过期**——日期让读者立刻知道对应哪个时点的仓库状态。做同一主题的复测/续测，另开一份新日期的文档，不改旧的。

## 索引

| 日期 | 主题 | 主要结论 |
|---|---|---|
| 2026-07-26 | [zonesvr 容量分析](2026-07-26-zonesvr-capacity.md) | 短连接重连风暴 vs 长连接稳态两条 hot path；rank 场景 cmd p99 长尾是 event loop tick lag readout 而非 mongo 真慢；RoundRobin + bistable 分裂锁定 w1；SAB 相对 postMessage 净差异 <4 %，wall:cpu 反而 +10 %；建议 LeastLoad LB + 加 worker 数。 |
