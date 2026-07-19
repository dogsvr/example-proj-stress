// Scenario C: zonesvr workerThreadNum scaling curve (one iteration).
// Run four times (w=1,2,4,8) via c_worker_scaling.sh; operator restarts zonesvr between runs.

import { createStressBot } from '../bot';
import { runBattleSession, DEFAULT_SESSION } from '../bot_battle';
import { runBotFleet } from '../bot_fleet';
import type { BotInnerLoop, BotOperation } from '../bot_fleet';
import { startTelemetry, stopTelemetry, sumCounter } from '../otel_client';
import { parseArgs, optNum, optStr } from '../cli';
import { runScenario, formatMs } from './scenario_shell';

const SCENARIO = 'c_worker_scaling';

interface ScenarioCParams {
    concurrency: number;
    durationMs: number;
    rampMs: number;
    workerThreadNum: number;
    syncType: 'state_sync' | 'lockstep_sync';
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
        zoneId: optNum(args, 'zone-id', 1),
    };
}

runScenario<ScenarioCParams>({
    scenario: SCENARIO,
    scenarioTag: (p) => `${SCENARIO}_w${p.workerThreadNum}`,
    readParams,
    body: async ({ scenario, params, startedAt }) => {
        const battleOp: BotOperation = {
            name: 'battle',
            run: (bot, ctx) => runBattleSession(bot, params.syncType, DEFAULT_SESSION, ctx.abortSignal),
        };
        const innerLoop: BotInnerLoop = { kind: 'sequence', ops: [battleOp] };

        await runBotFleet({
            scenario,
            concurrency: params.concurrency,
            durationMs: params.durationMs,
            rampMs: params.rampMs,
            innerLoop,
            onShardInit: () => { startTelemetry(); },
            onShardShutdown: async () => { await stopTelemetry(); },
            setupBot: async (globalIndex) => {
                const seq = globalIndex % Math.max(1, params.concurrency);
                const bot = createStressBot(seq, scenario, params.zoneId);
                await bot.connectAndLogin();
                return bot;
            },
        });

        const finishedAt = Date.now();
        const successes = sumCounter('bot_cycle_success_total');
        const failures = sumCounter('bot_cycle_failure_total');
        const totalCycles = successes + failures;
        const errorRate = totalCycles > 0 ? failures / totalCycles : 0;
        const qps = totalCycles > 0 ? totalCycles / ((finishedAt - startedAt) / 1000) : 0;

        return {
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
        };
    },
});
