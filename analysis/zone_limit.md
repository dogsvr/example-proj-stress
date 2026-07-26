# 参照数据

```
<ZoneRegistLimit>
    <max_register_num>41000</max_register_num>
</ZoneRegistLimit>
```

实际上限 4w - 6w 多

---

2026.7.25

总 pcu: 156w

awx 单物理机器 pcu: 峰值 2k, 主分布 1 - 1.5k

---

qps:


# 实际压测数据

example-proj-stress/reports/2026-07-12T12-13-e_login_qps/summary.md
connect+login loop 重连风暴  2.24k/s   sab   

main thread cpu 接近100, 单 worker 50%, sab 无改善

进程 rss 600m  sab 似乎有改善  (对照 1.4k/s 720m)

---

example-proj-stress/reports/2026-07-26T06-50-f_realistic_session/summary.md
query rank  loop   3.14k/s  postmessage

main thread cpu 64%, 单 worker 近 100%

进程 rss 1.06g

P99 cmd duration 近 1s  (mongo: 500ms, redis: 130ms)

---

example-proj-stress/reports/2026-07-26T07-46-f_realistic_session/summary.md
query rank  loop   3.26k/s  sab

sab 无改善

日志输出: 323M / 5 min  (按 256M 算过一次, 日志输出不是瓶颈)

