// Scenario D: hot-update robustness.
// Same load as B; operator triggers `pm2 trigger zonesvr hotUpdate` at t=triggerAtMs.
// Bots auto-reconnect with exponential backoff. Only `disconnect` failures count against the verdict.

import { Bot, DEFAULT_ENDPOINTS } from '../bot_login';
import { runBattleSession, DEFAULT_SESSION } from '../bot_battle';
import { runPool } from '../bot_pool';
import { startBotMetricsEndpoint, stopBotMetricsEndpoint, sumCounter, collectByLabel } from '../otel_metrics_client';
import { setupBotTracing, shutdownBotTracing } from '../otel_tracing_client';
import { writeReport } from '../report';
import { parseArgs, optNum, optStr, formatMs } from '../cli';
import { log } from '../log';

const SCENARIO = 'd_hot_update';

interface ScenarioDParams {
    concurrency: number;
    durationMs: number;
    rampMs: number;
    triggerAtMs: number;
    syncType: 'state_sync' | 'lockstep_sync';
    gidBase: number;
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
        gidBase: optNum(args, 'gid-base', 8_000_000),
        zoneId: optNum(args, 'zone-id', 1),
    };
}

const RECONNECT_BACKOFF_MS = [200, 500, 1000, 2000, 5000];

async function main(): Promise<void> {
    const params = readParams();
    log.info({ params }, `${SCENARIO} starting`);
    setupBotTracing({ serviceName: 'stress-bots' });
    startBotMetricsEndpoint();
    const startedAt = Date.now();

    log.info(
        { triggerAtMs: params.triggerAtMs },
        `script will continue running through hot-update window; operator must trigger \`pm2 trigger zonesvr hotUpdate\` at ~t=${params.triggerAtMs}ms (relative to this start)`,
    );

    await runPool({
        scenario: SCENARIO,
        concurrency: params.concurrency,
        durationMs: params.durationMs,
        rampMs: params.rampMs,
        cycleFn: async (botIndex: number) => {
            const seq = botIndex % Math.max(1, params.concurrency);
            const bot = new Bot(
                { openId: `stress_${seq}`, zoneId: params.zoneId, name: `bot_${seq}` },
                SCENARIO,
                DEFAULT_ENDPOINTS,
            );
            try {
                await connectWithRetry(bot);
                await runBattleSession(bot, params.syncType, DEFAULT_SESSION);
            } finally {
                await bot.disconnect();
            }
        },
    });

    const finishedAt = Date.now();
    const totalSuccess = sumCounter('bot_cycle_success_total');
    const failuresByPhase = collectByLabel('bot_cycle_failure_total', 'phase');
    const totalCycles = totalSuccess + sumValues(failuresByPhase);

    const disconnectFails = failuresByPhase['disconnect'] ?? 0;
    const timeoutFails = failuresByPhase['timeout'] ?? 0;
    const otherFails = (failuresByPhase['server_error'] ?? 0) + (failuresByPhase['unknown'] ?? 0);
    const disconnectRate = totalCycles > 0 ? disconnectFails / totalCycles : 0;

    const passed = disconnectRate < 0.05;  // 5% tolerance during hot update
    await writeReport({
        scenario: SCENARIO,
        startedAt,
        finishedAt,
        params: params as unknown as Record<string, unknown>,
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
    });

    await stopBotMetricsEndpoint();
    await shutdownBotTracing();
}

async function connectWithRetry(bot: Bot): Promise<void> {
    let attempt = 0;
    let lastErr: unknown;
    while (attempt <= RECONNECT_BACKOFF_MS.length) {
        try {
            await bot.connectAndLogin();
            return;
        } catch (err) {
            lastErr = err;
            const wait = RECONNECT_BACKOFF_MS[Math.min(attempt, RECONNECT_BACKOFF_MS.length - 1)];
            await sleep(wait + Math.random() * wait * 0.2);
            attempt++;
        }
    }
    throw lastErr;
}

function sumValues(o: Record<string, number>): number {
    return Object.values(o).reduce((a, v) => a + v, 0);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
    log.error({ err: String(err) }, `${SCENARIO} failed`);
    process.exit(1);
});
