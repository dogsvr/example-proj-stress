// Scenario B: login / start_battle / battle_end key business flow under progressive concurrency.

import { Bot, DEFAULT_ENDPOINTS } from '../bot_login';
import { runBattleSession, DEFAULT_SESSION } from '../bot_battle';
import { runBotFleet } from '../bot_pool';
import type { BotInnerLoop, BotOperation, OuterLoopOptions } from '../bot_runtime';
import { startBotMetricsEndpoint, stopBotMetricsEndpoint, sumCounter } from '../otel_metrics_client';
import { setupBotTracing, shutdownBotTracing } from '../otel_tracing_client';
import { writeReport } from '../report';
import { parseArgs, optNum, optStr, formatMs, hasFlag } from '../cli';
import { log } from '../log';

const SCENARIO = 'b_login_battle_end';

interface ScenarioBParams {
    concurrency: number;
    durationMs: number;
    rampMs: number;
    gracefulStopMs: number;
    syncType: 'state_sync' | 'lockstep_sync';
    gidBase: number;
    zoneId: number;
    reloginEveryCycles: number;
    reloginEveryMs: number;
}

function readParams(): ScenarioBParams {
    const args = parseArgs();
    const sync = optStr(args, 'syncType', 'state_sync');
    if (sync !== 'state_sync' && sync !== 'lockstep_sync') {
        throw new Error(`invalid --syncType ${sync}; expected state_sync or lockstep_sync`);
    }
    if (hasFlag(args, 'relogin-every-cycles') && hasFlag(args, 'relogin-every-ms')) {
        throw new Error('--relogin-every-cycles and --relogin-every-ms are mutually exclusive');
    }
    return {
        concurrency: optNum(args, 'concurrency', 100),
        durationMs: optNum(args, 'duration', 300_000),
        rampMs: optNum(args, 'ramp', 60_000),
        gracefulStopMs: optNum(args, 'graceful-stop-ms', 15_000),
        syncType: sync,
        gidBase: optNum(args, 'gid-base', 8_000_000),
        zoneId: optNum(args, 'zone-id', 1),
        reloginEveryCycles: optNum(args, 'relogin-every-cycles', 0),
        reloginEveryMs: optNum(args, 'relogin-every-ms', 0),
    };
}

function buildOuterLoop(params: ScenarioBParams): OuterLoopOptions | undefined {
    if (params.reloginEveryCycles > 0) return { kind: 'cycles', everyN: params.reloginEveryCycles };
    if (params.reloginEveryMs > 0) return { kind: 'time', everyMs: params.reloginEveryMs };
    return undefined;
}

async function main(): Promise<void> {
    const params = readParams();
    log.info({ params }, `${SCENARIO} starting`);

    const startedAt = Date.now();

    const battleOp: BotOperation = {
        name: 'battle',
        run: (bot, ctx) => runBattleSession(bot, params.syncType, DEFAULT_SESSION, ctx.abortSignal),
    };
    const innerLoop: BotInnerLoop = { kind: 'sequence', ops: [battleOp] };

    await runBotFleet({
        scenario: SCENARIO,
        concurrency: params.concurrency,
        durationMs: params.durationMs,
        rampMs: params.rampMs,
        gracefulStopMs: params.gracefulStopMs,
        innerLoop,
        outerLoop: buildOuterLoop(params),
        onWorkerInit: () => {
            setupBotTracing({ serviceName: 'stress-bots' });
            startBotMetricsEndpoint();
        },
        onWorkerShutdown: async () => {
            await stopBotMetricsEndpoint();
            await shutdownBotTracing();
        },
        setupBot: async (globalIndex: number) => {
            const seq = (params.gidBase - 8_000_000) + (globalIndex % Math.max(1, params.concurrency));
            const bot = new Bot(
                {
                    openId: `stress_${seq}`,
                    zoneId: params.zoneId,
                    name: `bot_${seq}`,
                },
                SCENARIO,
                DEFAULT_ENDPOINTS,
            );
            await bot.connectAndLogin();
            return bot;
        },
    });

    const finishedAt = Date.now();
    log.info({ durationMs: finishedAt - startedAt }, `${SCENARIO} finished, writing report`);

    const cycles = sumCounter('bot_cycle_success_total');
    const failures = sumCounter('bot_cycle_failure_total');
    const totalCycles = cycles + failures;
    const errorRate = totalCycles > 0 ? failures / totalCycles : 0;

    const passed = errorRate < 0.01;
    await writeReport({
        scenario: SCENARIO,
        startedAt,
        finishedAt,
        params: params as unknown as Record<string, unknown>,
        verdict: {
            passed,
            reason: passed
                ? `bot 错误率 ${(errorRate * 100).toFixed(2)}% < 1% 阈值。详细 p99/QPS 请查看 Grafana dashboard 'dogsvr Overview'。`
                : `bot 错误率 ${(errorRate * 100).toFixed(2)}% 超过 1% 阈值。检查 Grafana dashboard + dogsvr_txn_timeout_total 增量。`,
            keyStats: {
                'concurrency': params.concurrency,
                'duration': formatMs(params.durationMs),
                'ramp': formatMs(params.rampMs),
                'graceful_stop': formatMs(params.gracefulStopMs),
                'syncType': params.syncType,
                'cycles_total': totalCycles,
                'cycles_success': cycles,
                'cycles_failure': failures,
                'error_rate': `${(errorRate * 100).toFixed(2)}%`,
                'relogin_every_cycles': params.reloginEveryCycles || '-',
                'relogin_every_ms': params.reloginEveryMs ? formatMs(params.reloginEveryMs) : '-',
            },
        },
        notes: [
            `查看 Grafana panels:\n  - dogsvr_cmd_duration_ms{cmdId="ZONE_LOGIN"} p99/QPS\n  - mongo_op_duration_ms{coll="role_coll"}\n  - redis_op_duration_ms{op="set"} (锁获取)`,
            `场景 B 是 C 和 D 的基线,如果这里就异常,先修复再跑 C/D。`,
            `cluster 模式 (concurrency > 500) 下 cycles_total 始终为 0,以 Grafana 为准。`,
        ],
    });
}

main().catch((err) => {
    log.error({ err: String(err) }, `${SCENARIO} failed`);
    process.exit(1);
});
