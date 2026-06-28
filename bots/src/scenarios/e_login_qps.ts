// Scenario E: ZONE_LOGIN throughput under high concurrency.

import { Bot, DEFAULT_ENDPOINTS } from '../bot_login';
import { runBotFleet } from '../bot_pool';
import type { BotInnerLoop, BotOperation } from '../bot_runtime';
import { startBotMetrics, stopBotMetrics } from '../otel_metrics_client';
import { queryFinalCounters } from '../prom_query';
import { setupBotTracing, shutdownBotTracing } from '../otel_tracing_client';
import { writeReport } from '../report';
import { parseArgs, optNum, formatMs } from '../cli';
import { log } from '../log';

const SCENARIO = 'e_login_qps';

interface ScenarioEParams {
    concurrency: number;
    durationMs: number;
    rampMs: number;
    gracefulStopMs: number;
    gidBase: number;
    zoneId: number;
}

function readParams(): ScenarioEParams {
    const args = parseArgs();
    return {
        concurrency: optNum(args, 'concurrency', 500),
        durationMs: optNum(args, 'duration', 60_000),
        rampMs: optNum(args, 'ramp', 10_000),
        gracefulStopMs: optNum(args, 'graceful-stop-ms', 15_000),
        gidBase: optNum(args, 'gid-base', 8_000_000),
        zoneId: optNum(args, 'zone-id', 1),
    };
}

async function main(): Promise<void> {
    const params = readParams();
    log.info({ params }, `${SCENARIO} starting`);

    const startedAt = Date.now();

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
        onWorkerInit: () => {
            setupBotTracing({ serviceName: 'stress-bots' });
            startBotMetrics();
        },
        onWorkerShutdown: async () => {
            await stopBotMetrics();
            await shutdownBotTracing();
        },
        // no pre-login: every login counted as a cycle
        setupBot: async (globalIndex: number) => {
            const seq = (params.gidBase - 8_000_000) + (globalIndex % Math.max(1, params.concurrency));
            return new Bot(
                {
                    openId: `stress_${seq}`,
                    zoneId: params.zoneId,
                    name: `bot_${seq}`,
                },
                SCENARIO,
                DEFAULT_ENDPOINTS,
            );
        },
    });

    const finishedAt = Date.now();
    log.info({ durationMs: finishedAt - startedAt }, `${SCENARIO} finished, querying final counters from Prometheus`);

    const runId = process.env.STRESS_RUN_ID ?? `pid-${process.pid}`;
    const stats = await queryFinalCounters({ scenario: SCENARIO, runId, startedAt, finishedAt });

    const passed = stats.ok ? (stats.cyclesTotal + stats.failuresTotal > 0
        ? stats.failuresTotal / (stats.cyclesTotal + stats.failuresTotal) < 0.01
        : false) : false;
    const errorRate = stats.ok && (stats.cyclesTotal + stats.failuresTotal > 0)
        ? stats.failuresTotal / (stats.cyclesTotal + stats.failuresTotal)
        : 0;

    await writeReport({
        scenario: SCENARIO,
        startedAt,
        finishedAt,
        params: params as unknown as Record<string, unknown>,
        verdict: {
            passed,
            reason: !stats.ok
                ? `Prometheus 查询失败,verdict 不可判定 (inconclusive)。原因: ${stats.reason}。请查 Grafana dashboard 'dogsvr Overview' 人工判定。`
                : passed
                    ? `bot 错误率 ${(errorRate * 100).toFixed(2)}% < 1% 阈值。详细 p99/QPS 请查看 Grafana dashboard 'dogsvr Overview'。`
                    : `bot 错误率 ${(errorRate * 100).toFixed(2)}% 超过 1% 阈值。检查 Grafana dashboard + dogsvr_txn_timeout_total 增量。`,
            keyStats: stats.ok ? {
                'concurrency': params.concurrency,
                'duration': formatMs(params.durationMs),
                'ramp': formatMs(params.rampMs),
                'graceful_stop': formatMs(params.gracefulStopMs),
                'cycles_total': stats.cyclesTotal + stats.failuresTotal,
                'cycles_success': stats.cyclesTotal,
                'cycles_failure': stats.failuresTotal,
                'error_rate': `${(errorRate * 100).toFixed(2)}%`,
                'rtt_p50_ms': stats.rttP50?.toFixed(2) ?? 'n/a',
                'rtt_p95_ms': stats.rttP95?.toFixed(2) ?? 'n/a',
                'rtt_p99_ms': stats.rttP99?.toFixed(2) ?? 'n/a',
                'active_peak': stats.activePeak ?? 'n/a',
                'cycles_by_op': JSON.stringify(stats.cyclesByOp),
                'failures_by_phase': JSON.stringify(stats.failuresByPhase),
            } : {
                'concurrency': params.concurrency,
                'duration': formatMs(params.durationMs),
                'cycles_total': 'n/a (prom query failed)',
                'error_rate': 'n/a',
            },
        },
        notes: [
            `查看 Grafana panels:\n  - dogsvr_cmd_duration_milliseconds{cmdId="ZONE_LOGIN"} p99/QPS\n  - mongo_op_duration_milliseconds{coll="role_coll"}\n  - redis_op_duration_milliseconds{op="set"} (role lock 获取)`,
            `场景 E 衡量 ZONE_LOGIN 路径吞吐上限,主要压力点:dir 鉴权链 / zonesvr accept loop / role_coll mongo 写 / role lock redis。如发现 cycle 失败聚集在某 phase,优先排查对应组件。本场景的 inner op 仅 ZONE_LOGIN,故 keyStats 中 rtt_p* ≈ ZONE_LOGIN RTT。`,
            `若 active_peak 远低于 concurrency,说明 bot 端断路器(连续 3 次 op 失败 → 指数退避 reconnect,5 次穷举失败 → 退出)已介入,实际 server 已饱和;此时 cycles_total 会偏低,需结合 server 端 dogsvr_cmd_duration_milliseconds{cmdId="ZONE_LOGIN"} QPS 一起看。`,
            `运行前确认 ulimit -n ≥ 4096;高并发短连接循环会快速堆 TIME_WAIT,如 60s 内压不出预期 QPS,可结合 ss -s 看本地端口占用。`,
            `cycles/failures 来自 Prometheus instant query (run_id=${runId},OTLP push interval 5s,允许 ±5s 计数尾差);RTT 分位见 keyStats / Grafana。`,
        ],
    });
}

main().catch((err) => {
    log.error({ err: String(err) }, `${SCENARIO} failed`);
    process.exit(1);
});
