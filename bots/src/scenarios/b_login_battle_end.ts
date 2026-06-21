// Scenario B: login / start_battle / battle_end key business flow under progressive concurrency.

import { Bot, DEFAULT_ENDPOINTS } from '../bot_login';
import { runBattleSession, DEFAULT_SESSION } from '../bot_battle';
import { runPool } from '../bot_pool';
import { startBotMetricsEndpoint, stopBotMetricsEndpoint, sumCounter } from '../otel_metrics_client';
import { setupBotTracing, shutdownBotTracing } from '../otel_tracing_client';
import { writeReport } from '../report';
import { parseArgs, optNum, optStr, formatMs } from '../cli';
import { log } from '../log';

const SCENARIO = 'b_login_battle_end';

interface ScenarioBParams {
    concurrency: number;
    durationMs: number;
    rampMs: number;
    syncType: 'state_sync' | 'lockstep_sync';
    gidBase: number;
    zoneId: number;
}

function readParams(): ScenarioBParams {
    const args = parseArgs();
    const sync = optStr(args, 'syncType', 'state_sync');
    if (sync !== 'state_sync' && sync !== 'lockstep_sync') {
        throw new Error(`invalid --syncType ${sync}; expected state_sync or lockstep_sync`);
    }
    return {
        concurrency: optNum(args, 'concurrency', 100),
        durationMs: optNum(args, 'duration', 300_000),
        rampMs: optNum(args, 'ramp', 60_000),
        syncType: sync,
        gidBase: optNum(args, 'gid-base', 8_000_000),
        zoneId: optNum(args, 'zone-id', 1),
    };
}

async function main(): Promise<void> {
    const params = readParams();
    log.info({ params }, `${SCENARIO} starting`);
    setupBotTracing({ serviceName: 'stress-bots' });
    startBotMetricsEndpoint();

    const startedAt = Date.now();

    await runPool({
        scenario: SCENARIO,
        concurrency: params.concurrency,
        durationMs: params.durationMs,
        rampMs: params.rampMs,
        cycleFn: async (botIndex: number) => {
            const seq = (params.gidBase - 8_000_000) + (botIndex % Math.max(1, params.concurrency));
            const bot = new Bot(
                {
                    openId: `stress_${seq}`,
                    zoneId: params.zoneId,
                    name: `bot_${seq}`,
                },
                SCENARIO,
                DEFAULT_ENDPOINTS,
            );
            try {
                await bot.connectAndLogin();
                await runBattleSession(bot, params.syncType, DEFAULT_SESSION);
            } finally {
                await bot.disconnect();
            }
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
                'syncType': params.syncType,
                'cycles_total': totalCycles,
                'cycles_success': cycles,
                'cycles_failure': failures,
                'error_rate': `${(errorRate * 100).toFixed(2)}%`,
            },
        },
        notes: [
            `查看 Grafana panels:\n  - dogsvr_cmd_duration_ms{cmdId="ZONE_LOGIN"} p99/QPS\n  - mongo_op_duration_ms{coll="role_coll"}\n  - redis_op_duration_ms{op="set"} (锁获取)`,
            `场景 B 是 C 和 D 的基线,如果这里就异常,先修复再跑 C/D。`,
        ],
    });

    await stopBotMetricsEndpoint();
    await shutdownBotTracing();
}

main().catch((err) => {
    log.error({ err: String(err) }, `${SCENARIO} failed`);
    process.exit(1);
});
