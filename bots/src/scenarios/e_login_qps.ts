// Scenario E: ZONE_LOGIN throughput under high concurrency.

import { createStressBot } from '../bot';
import { runBotFleet } from '../bot_fleet';
import type { BotInnerLoop, BotOperation } from '../bot_fleet';
import { startTelemetry, stopTelemetry } from '../otel_client';
import { queryFinalCounters } from '../prom_query';
import { parseArgs, optNum } from '../cli';
import { log } from '../log';
import { runScenario, verdictFromPromStats, promStatsKeyStats, getRunId, formatMs } from './scenario_shell';

const SCENARIO = 'e_login_qps';

interface ScenarioEParams {
    concurrency: number;
    durationMs: number;
    rampMs: number;
    gracefulStopMs: number;
    zoneId: number;
}

function readParams(): ScenarioEParams {
    const args = parseArgs();
    return {
        concurrency: optNum(args, 'concurrency', 500),
        durationMs: optNum(args, 'duration', 60_000),
        rampMs: optNum(args, 'ramp', 10_000),
        gracefulStopMs: optNum(args, 'graceful-stop-ms', 15_000),
        zoneId: optNum(args, 'zone-id', 1),
    };
}

runScenario<ScenarioEParams>({
    scenario: SCENARIO,
    readParams,
    body: async ({ params, startedAt }) => {
        const loginOp: BotOperation = {
            name: 'login_cycle',
            run: async (bot) => {
                await bot.connectAndLogin();
                await bot.disconnect();
            },
        };
        const innerLoop: BotInnerLoop = { kind: 'sequence', ops: [loginOp] };

        await runBotFleet({
            scenario: SCENARIO,
            concurrency: params.concurrency,
            durationMs: params.durationMs,
            rampMs: params.rampMs,
            gracefulStopMs: params.gracefulStopMs,
            innerLoop,
            onShardInit: () => { startTelemetry(); },
            onShardShutdown: async () => { await stopTelemetry(); },
            setupBot: async (globalIndex) => {
                const seq = globalIndex % Math.max(1, params.concurrency);
                return createStressBot(seq, SCENARIO, params.zoneId);
            },
        });

        const finishedAt = Date.now();
        log.info({ durationMs: finishedAt - startedAt }, `${SCENARIO} finished, querying final counters from Prometheus`);

        const runId = getRunId();
        const stats = await queryFinalCounters({ scenario: SCENARIO, runId, startedAt, finishedAt });
        const v = verdictFromPromStats(stats, {
            threshold: 0.01,
            ok: (r) => `bot 错误率 ${r} < 1% 阈值。详细 p99/QPS 请查看 Grafana dashboard 'dogsvr Overview'。`,
            fail: (r) => `bot 错误率 ${r} 超过 1% 阈值。检查 Grafana dashboard + dogsvr_txn_timeout_total 增量。`,
            inconclusive: (why) => `Prometheus 查询失败,verdict 不可判定 (inconclusive)。原因: ${why}。请查 Grafana dashboard 'dogsvr Overview' 人工判定。`,
        });
        const keyStats = promStatsKeyStats(stats, {
            'concurrency': params.concurrency,
            'duration': formatMs(params.durationMs),
            'ramp': formatMs(params.rampMs),
            'graceful_stop': formatMs(params.gracefulStopMs),
        }, v.errorRate);

        return {
            verdict: { passed: v.passed, reason: v.reason, keyStats },
            notes: [
                `查看 Grafana panels:\n  - dogsvr_cmd_duration_milliseconds{cmdId="ZONE_LOGIN"} p99/QPS\n  - mongo_op_duration_milliseconds{coll="role_coll"}\n  - redis_op_duration_milliseconds{op="set"} (role lock 获取)`,
                `场景 E 衡量 ZONE_LOGIN 路径吞吐上限,主要压力点:dir 鉴权链 / zonesvr accept loop / role_coll mongo 写 / role lock redis。如发现 cycle 失败聚集在某 phase,优先排查对应组件。本场景的 inner op 仅 ZONE_LOGIN,故 keyStats 中 rtt_p* ≈ ZONE_LOGIN RTT。`,
                `若 active_peak 远低于 concurrency,说明 bot 端断路器(连续 3 次 op 失败 → 指数退避 reconnect,5 次穷举失败 → 退出)已介入,实际 server 已饱和;此时 cycles_total 会偏低,需结合 server 端 dogsvr_cmd_duration_milliseconds{cmdId="ZONE_LOGIN"} QPS 一起看。`,
                `运行前确认 ulimit -n ≥ 4096;高并发短连接循环会快速堆 TIME_WAIT,如 60s 内压不出预期 QPS,可结合 ss -s 看本地端口占用。`,
                `cycles/failures 来自 Prometheus instant query (run_id=${runId},OTLP push interval 5s,允许 ±5s 计数尾差);RTT 分位见 keyStats / Grafana。`,
            ],
        };
    },
});
