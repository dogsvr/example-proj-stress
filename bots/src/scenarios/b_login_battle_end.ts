// Scenario B: login / start_battle / battle_end key business flow under progressive concurrency.

import { createStressBot } from '../bot';
import { runBattleSession, DEFAULT_SESSION } from '../bot_battle';
import { runBotFleet } from '../bot_fleet';
import type { BotInnerLoop, BotOperation, OuterLoopOptions } from '../bot_fleet';
import { startTelemetry, stopTelemetry } from '../otel_client';
import { queryFinalCounters } from '../prom_query';
import { parseArgs, optNum, optStr, hasFlag } from '../cli';
import { log } from '../log';
import { runScenario, verdictFromPromStats, promStatsKeyStats, getRunId, formatMs } from './scenario_shell';

const SCENARIO = 'b_login_battle_end';

interface ScenarioBParams {
    concurrency: number;
    durationMs: number;
    rampMs: number;
    gracefulStopMs: number;
    syncType: 'state_sync' | 'lockstep_sync';
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

runScenario<ScenarioBParams>({
    scenario: SCENARIO,
    readParams,
    body: async ({ params, startedAt }) => {
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
            onShardInit: () => { startTelemetry(); },
            onShardShutdown: async () => { await stopTelemetry(); },
            setupBot: async (globalIndex) => {
                const seq = globalIndex % Math.max(1, params.concurrency);
                const bot = createStressBot(seq, SCENARIO, params.zoneId);
                await bot.connectAndLogin();
                return bot;
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

        const baseStats = {
            'concurrency': params.concurrency,
            'duration': formatMs(params.durationMs),
            'ramp': formatMs(params.rampMs),
            'graceful_stop': formatMs(params.gracefulStopMs),
            'syncType': params.syncType,
        };
        const keyStats = promStatsKeyStats(stats, baseStats, v.errorRate);
        if (stats.ok) {
            keyStats['relogin_every_cycles'] = params.reloginEveryCycles || '-';
            keyStats['relogin_every_ms'] = params.reloginEveryMs ? formatMs(params.reloginEveryMs) : '-';
        }

        return {
            verdict: { passed: v.passed, reason: v.reason, keyStats },
            notes: [
                `查看 Grafana panels:\n  - dogsvr_cmd_duration_milliseconds{cmdId="ZONE_LOGIN"} p99/QPS\n  - mongo_op_duration_milliseconds{coll="role_coll"}\n  - redis_op_duration_milliseconds{op="set"} (锁获取)`,
                `场景 B 是 C 和 D 的基线,如果这里就异常,先修复再跑 C/D。`,
                `cycles/failures 来自 Prometheus instant query (run_id=${runId},OTLP push interval 5s,允许 ±5s 计数尾差);RTT 分位见 keyStats / Grafana。`,
            ],
        };
    },
});
