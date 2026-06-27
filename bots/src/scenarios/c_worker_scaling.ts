// Scenario C: zonesvr workerThreadNum scaling curve (one iteration).
// Run four times (w=1,2,4,8) via c_worker_scaling.sh; operator restarts zonesvr between runs.

import { Bot, DEFAULT_ENDPOINTS } from '../bot_login';
import { runBattleSession, DEFAULT_SESSION } from '../bot_battle';
import { runPool } from '../bot_pool';
import { startBotMetrics, stopBotMetrics, sumCounter } from '../otel_metrics_client';
import { setupBotTracing, shutdownBotTracing } from '../otel_tracing_client';
import { writeReport } from '../report';
import { parseArgs, optNum, optStr, formatMs } from '../cli';
import { log } from '../log';

const SCENARIO = 'c_worker_scaling';

interface ScenarioCParams {
    concurrency: number;
    durationMs: number;
    rampMs: number;
    workerThreadNum: number;
    syncType: 'state_sync' | 'lockstep_sync';
    gidBase: number;
    zoneId: number;
}

function readParams(): ScenarioCParams {
    const args = parseArgs();
    const sync = optStr(args, 'syncType', 'state_sync');
    if (sync !== 'state_sync' && sync !== 'lockstep_sync') {
        throw new Error(`invalid --syncType ${sync}`);
    }
    return {
        concurrency: optNum(args, 'concurrency', 100),
        durationMs: optNum(args, 'duration', 180_000),
        rampMs: optNum(args, 'ramp', 30_000),
        workerThreadNum: optNum(args, 'worker-thread-num', 0),
        syncType: sync,
        gidBase: optNum(args, 'gid-base', 8_000_000),
        zoneId: optNum(args, 'zone-id', 1),
    };
}

async function main(): Promise<void> {
    const params = readParams();
    log.info({ params }, `${SCENARIO} starting (one iteration)`);
    setupBotTracing({ serviceName: 'stress-bots' });
    startBotMetrics();
    const startedAt = Date.now();

    await runPool({
        scenario: `${SCENARIO}_w${params.workerThreadNum}`,
        concurrency: params.concurrency,
        durationMs: params.durationMs,
        rampMs: params.rampMs,
        cycleFn: async (botIndex: number) => {
            const seq = botIndex % Math.max(1, params.concurrency);
            const bot = new Bot(
                {
                    openId: `stress_${seq}`,
                    zoneId: params.zoneId,
                    name: `bot_${seq}`,
                },
                `${SCENARIO}_w${params.workerThreadNum}`,
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
    const successes = sumCounter('bot_cycle_success_total');
    const failures = sumCounter('bot_cycle_failure_total');
    const totalCycles = successes + failures;
    const errorRate = totalCycles > 0 ? failures / totalCycles : 0;
    const qps = totalCycles > 0 ? totalCycles / ((finishedAt - startedAt) / 1000) : 0;

    await writeReport({
        scenario: `${SCENARIO}_w${params.workerThreadNum}`,
        startedAt,
        finishedAt,
        params: params as unknown as Record<string, unknown>,
        verdict: {
            passed: errorRate < 0.01,
            reason: `单档完成: workerThreadNum=${params.workerThreadNum}, total cycle/s ≈ ${qps.toFixed(1)}, errorRate=${(errorRate * 100).toFixed(2)}%。多档汇总请看 c_worker_scaling.sh 串联生成的总报告。`,
            keyStats: {
                'workerThreadNum': params.workerThreadNum,
                'concurrency': params.concurrency,
                'duration': formatMs(params.durationMs),
                'cycle_success': successes,
                'cycle_failure': failures,
                'cycle_qps': qps.toFixed(2),
                'error_rate': `${(errorRate * 100).toFixed(2)}%`,
            },
        },
        notes: [
            `单档结果与其他档对比看 Grafana dashboard 'Worker Scaling':\n  - dogsvr_worker_pending by worker label (应 <10% 偏差)\n  - main_thread CPU vs worker CPU\n  - cmd p99 by cmdId`,
            `汇总折线请用 c_worker_scaling.sh 自动串 1/2/4/8 档,然后看每档的 cycle_qps。`,
        ],
    });

    await stopBotMetrics();
    await shutdownBotTracing();
}

main().catch((err) => {
    log.error({ err: String(err) }, `${SCENARIO} failed`);
    process.exit(1);
});
