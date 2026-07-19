// Scenario D: hot-update robustness.
// Same load as B; operator triggers `pm2 trigger zonesvr hotUpdate` at t=triggerAtMs.
// Bots auto-reconnect via driveBot circuit-breaker. Only `disconnect` failures count against the verdict.

import { createStressBot } from '../bot';
import { runBattleSession, DEFAULT_SESSION } from '../bot_battle';
import { runBotFleet, reconnectWithBackoff } from '../bot_fleet';
import type { BotInnerLoop, BotOperation } from '../bot_fleet';
import { startTelemetry, stopTelemetry, sumCounter, collectByLabel } from '../otel_client';
import { parseArgs, optNum, optStr } from '../cli';
import { log } from '../log';
import { runScenario, formatMs } from './scenario_shell';

const SCENARIO = 'd_hot_update';

interface ScenarioDParams {
    concurrency: number;
    durationMs: number;
    rampMs: number;
    triggerAtMs: number;
    syncType: 'state_sync' | 'lockstep_sync';
    zoneId: number;
}

function readParams(): ScenarioDParams {
    const args = parseArgs();
    const sync = optStr(args, 'syncType', 'state_sync');
    if (sync !== 'state_sync' && sync !== 'lockstep_sync') {
        throw new Error(`invalid --syncType ${sync}`);
    }
    return {
        concurrency: optNum(args, 'concurrency', 100),
        durationMs: optNum(args, 'duration', 300_000),
        rampMs: optNum(args, 'ramp', 30_000),
        triggerAtMs: optNum(args, 'trigger-at', 120_000),
        syncType: sync,
        zoneId: optNum(args, 'zone-id', 1),
    };
}

runScenario<ScenarioDParams>({
    scenario: SCENARIO,
    readParams,
    body: async ({ params }) => {
        log.info(
            { triggerAtMs: params.triggerAtMs },
            `operator must trigger \`pm2 trigger zonesvr hotUpdate\` at ~t=${params.triggerAtMs}ms after this start`,
        );

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
            innerLoop,
            onShardInit: () => { startTelemetry(); },
            onShardShutdown: async () => { await stopTelemetry(); },
            setupBot: async (globalIndex) => {
                const seq = globalIndex % Math.max(1, params.concurrency);
                const bot = createStressBot(seq, SCENARIO, params.zoneId);
                await reconnectWithBackoff(bot);
                return bot;
            },
        });

        const totalSuccess = sumCounter('bot_cycle_success_total');
        const failuresByPhase = collectByLabel('bot_cycle_failure_total', 'phase');
        const totalFails = Object.values(failuresByPhase).reduce((a, v) => a + v, 0);
        const totalCycles = totalSuccess + totalFails;

        const disconnectFails = failuresByPhase['disconnect'] ?? 0;
        const timeoutFails = failuresByPhase['timeout'] ?? 0;
        const otherFails = (failuresByPhase['server_error'] ?? 0) + (failuresByPhase['unknown'] ?? 0);
        const disconnectRate = totalCycles > 0 ? disconnectFails / totalCycles : 0;

        const passed = disconnectRate < 0.05;

        return {
            verdict: {
                passed,
                reason: passed
                    ? `disconnect 占比 ${(disconnectRate * 100).toFixed(2)}% < 5% (热更窗口可接受)。dip 深度与恢复时间请查 Grafana dashboard 'dogsvr Overview'。`
                    : `disconnect 占比 ${(disconnectRate * 100).toFixed(2)}% 超过 5% — 热更未达到无感水平。`,
                keyStats: {
                    'concurrency': params.concurrency,
                    'duration': formatMs(params.durationMs),
                    'trigger_at': formatMs(params.triggerAtMs),
                    'cycles_total': totalCycles,
                    'cycles_success': totalSuccess,
                    'fails_disconnect': disconnectFails,
                    'fails_timeout': timeoutFails,
                    'fails_other': otherFails,
                    'disconnect_rate': `${(disconnectRate * 100).toFixed(2)}%`,
                },
            },
            notes: [
                `disconnect 是热更核心指标;timeout / server_error 不计入热更影响判定。`,
                `Grafana 'dogsvr Overview' 看 ZONE_LOGIN error rate / dogsvr_txn_timeout_total 在 trigger_at 时间点的尖峰。`,
            ],
        };
    },
});
