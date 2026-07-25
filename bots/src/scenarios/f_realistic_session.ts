// Scenario F: realistic-user session mix.
// Each bot cycles login -> [heartbeat timer + weighted battle/rank ops for random online span]
// -> disconnect -> random offline gap -> re-login. Steady PCU ≈ concurrency × online/(online+offline).
//
// Example (all flags shown with defaults):
//   node dist/scenarios/f_realistic_session.js \
//       --concurrency 200 --duration 300000 --ramp 60000 --graceful-stop-ms 15000 \
//       --sync-type state_sync --zone-id 1 \
//       --online-min-ms 60000 --online-max-ms 180000 \
//       --offline-min-ms 5000 --offline-max-ms 30000 \
//       --heartbeat-interval-ms 30000 \
//       --weight-battle 1 --weight-rank 3 --rank-id 1 --rank-count 100 \
//       --battle-duration-ms 8000 --battle-input-interval-ms 100

import { createStressBot, type Bot } from '../bot';
import { runBattleSession, DEFAULT_SESSION, type BattleSessionOptions } from '../bot_battle';
import { runBotFleet, sleepUntil, uniformInt, raceAbort } from '../bot_fleet';
import type { BotInnerLoop, BotOperation, OpContext } from '../bot_fleet';
import { startTelemetry, stopTelemetry } from '../otel_client';
import { queryFinalCounters } from '../prom_query';
import { parseArgs, optNum, optStr } from '../cli';
import { log } from '../log';
import { runScenario, verdictFromPromStats, promStatsKeyStats, getRunId, formatMs } from './scenario_shell';

const SCENARIO = 'f_realistic_session';

interface ScenarioFParams {
    concurrency: number;
    durationMs: number;
    rampMs: number;
    gracefulStopMs: number;
    syncType: 'state_sync' | 'lockstep_sync';
    zoneId: number;
    onlineMinMs: number;
    onlineMaxMs: number;
    offlineMinMs: number;
    offlineMaxMs: number;
    heartbeatIntervalMs: number;
    weightBattle: number;
    weightRank: number;
    rankId: number;
    rankCount: number;
    battleDurationMs: number;
    battleInputIntervalMs: number;
}

function readParams(): ScenarioFParams {
    const args = parseArgs();
    const sync = optStr(args, 'sync-type', 'state_sync');
    if (sync !== 'state_sync' && sync !== 'lockstep_sync') {
        throw new Error(`invalid --sync-type ${sync}; expected state_sync or lockstep_sync`);
    }
    const p: ScenarioFParams = {
        concurrency: optNum(args, 'concurrency', 200),
        durationMs: optNum(args, 'duration', 300_000),
        rampMs: optNum(args, 'ramp', 60_000),
        gracefulStopMs: optNum(args, 'graceful-stop-ms', 15_000),
        syncType: sync,
        zoneId: optNum(args, 'zone-id', 1),
        onlineMinMs: optNum(args, 'online-min-ms', 60_000),
        onlineMaxMs: optNum(args, 'online-max-ms', 180_000),
        offlineMinMs: optNum(args, 'offline-min-ms', 5_000),
        offlineMaxMs: optNum(args, 'offline-max-ms', 30_000),
        heartbeatIntervalMs: optNum(args, 'heartbeat-interval-ms', 30_000),
        weightBattle: optNum(args, 'weight-battle', 1),
        weightRank: optNum(args, 'weight-rank', 3),
        rankId: optNum(args, 'rank-id', 1),
        rankCount: optNum(args, 'rank-count', 100),
        battleDurationMs: optNum(args, 'battle-duration-ms', DEFAULT_SESSION.durationMs),
        battleInputIntervalMs: optNum(args, 'battle-input-interval-ms', DEFAULT_SESSION.inputIntervalMs),
    };
    if (p.onlineMinMs > p.onlineMaxMs) throw new Error('--online-min-ms > --online-max-ms');
    if (p.offlineMinMs > p.offlineMaxMs) throw new Error('--offline-min-ms > --offline-max-ms');
    if (p.heartbeatIntervalMs <= 0) throw new Error('--heartbeat-interval-ms must be > 0');
    if (p.weightBattle <= 0 && p.weightRank <= 0) throw new Error('at least one of --weight-battle / --weight-rank must be > 0');
    if (p.battleDurationMs <= 0) throw new Error('--battle-duration-ms must be > 0');
    if (p.battleInputIntervalMs <= 0) throw new Error('--battle-input-interval-ms must be > 0');
    return p;
}

interface SessionState {
    onlineUntil: number;
    heartbeatTimer: NodeJS.Timeout | null;
}

function startHeartbeatTimer(bot: Bot, intervalMs: number): NodeJS.Timeout {
    return setInterval(() => {
        bot.sendHeartbeat().catch(() => { /* silent between sessions */ });
    }, intervalMs);
}

function pickBusinessOp(weightBattle: number, weightRank: number): 'battle' | 'rank' {
    const total = Math.max(0, weightBattle) + Math.max(0, weightRank);
    if (total <= 0) return 'battle';
    return Math.random() * total < Math.max(0, weightBattle) ? 'battle' : 'rank';
}

runScenario<ScenarioFParams>({
    scenario: SCENARIO,
    readParams,
    body: async ({ params, startedAt }) => {
        const sessions = new Map<Bot, SessionState>();
        const battleOpts: BattleSessionOptions = {
            durationMs: params.battleDurationMs,
            inputIntervalMs: params.battleInputIntervalMs,
            reportKills: DEFAULT_SESSION.reportKills,
        };

        const sessionOp: BotOperation = {
            name: 'session_mix',
            run: async (bot: Bot, ctx: OpContext) => {
                if (ctx.abortSignal.aborted) return;
                let state = sessions.get(bot);
                if (!state) {
                    state = {
                        onlineUntil: Date.now() + uniformInt(params.onlineMinMs, params.onlineMaxMs),
                        heartbeatTimer: startHeartbeatTimer(bot, params.heartbeatIntervalMs),
                    };
                    sessions.set(bot, state);
                }

                if (Date.now() >= state.onlineUntil) {
                    if (state.heartbeatTimer) { clearInterval(state.heartbeatTimer); state.heartbeatTimer = null; }
                    await raceAbort(bot.disconnect(), ctx.abortSignal);
                    await sleepUntil(uniformInt(params.offlineMinMs, params.offlineMaxMs), ctx.abortSignal);
                    if (ctx.abortSignal.aborted) return;
                    await raceAbort(bot.connectAndLogin(), ctx.abortSignal);
                    state.onlineUntil = Date.now() + uniformInt(params.onlineMinMs, params.onlineMaxMs);
                    state.heartbeatTimer = startHeartbeatTimer(bot, params.heartbeatIntervalMs);
                }

                if (ctx.abortSignal.aborted) return;
                const pick = pickBusinessOp(params.weightBattle, params.weightRank);
                if (pick === 'battle') {
                    await runBattleSession(bot, params.syncType, battleOpts, ctx.abortSignal);
                } else {
                    await raceAbort(bot.queryRankList(params.rankId, 0, params.rankCount), ctx.abortSignal);
                }
            },
        };
        const innerLoop: BotInnerLoop = { kind: 'sequence', ops: [sessionOp] };

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
                const bot = createStressBot(seq, SCENARIO, params.zoneId);
                await bot.connectAndLogin();
                return bot;
            },
            teardownBot: async (bot) => {
                const s = sessions.get(bot);
                if (s?.heartbeatTimer) { clearInterval(s.heartbeatTimer); s.heartbeatTimer = null; }
                sessions.delete(bot);
                await bot.disconnect();
            },
        });

        const finishedAt = Date.now();
        log.info({ durationMs: finishedAt - startedAt }, `${SCENARIO} finished, querying final counters from Prometheus`);

        const runId = getRunId();
        const stats = await queryFinalCounters({ scenario: SCENARIO, runId, startedAt, finishedAt });
        const v = verdictFromPromStats(stats, {
            threshold: 0.01,
            ok: (r) => `bot 错误率 ${r} < 1% 阈值。详细 p99/QPS 请查看 Grafana dashboard 'dogsvr Overview'。`,
            fail: (r) => `bot 错误率 ${r} 超过 1% 阈值。检查 Grafana dashboard + 各 cmd error 分布。`,
            inconclusive: (why) => `Prometheus 查询失败,verdict 不可判定 (inconclusive)。原因: ${why}。请查 Grafana dashboard 'dogsvr Overview' 人工判定。`,
        });

        const baseStats = {
            'concurrency': params.concurrency,
            'duration': formatMs(params.durationMs),
            'ramp': formatMs(params.rampMs),
            'graceful_stop': formatMs(params.gracefulStopMs),
            'syncType': params.syncType,
            'online_range': `${formatMs(params.onlineMinMs)}~${formatMs(params.onlineMaxMs)}`,
            'offline_range': `${formatMs(params.offlineMinMs)}~${formatMs(params.offlineMaxMs)}`,
            'heartbeat_interval': formatMs(params.heartbeatIntervalMs),
            'weights': `battle:${params.weightBattle} rank:${params.weightRank}`,
            'battle_duration': formatMs(params.battleDurationMs),
            'battle_input_interval': formatMs(params.battleInputIntervalMs),
        };
        const keyStats = promStatsKeyStats(stats, baseStats, v.errorRate);

        const avgOnline = (params.onlineMinMs + params.onlineMaxMs) / 2;
        const avgOffline = (params.offlineMinMs + params.offlineMaxMs) / 2;
        const expectedPcuRatio = avgOnline / (avgOnline + avgOffline);
        const expectedActivePeak = Math.round(params.concurrency * expectedPcuRatio);

        return {
            verdict: { passed: v.passed, reason: v.reason, keyStats },
            notes: [
                `查看 Grafana panels:\n  - dogsvr_cmd_duration_milliseconds{cmdId="ZONE_HEARTBEAT"} p99/QPS\n  - dogsvr_cmd_duration_milliseconds{cmdId="ZONE_START_BATTLE"} p99/QPS\n  - dogsvr_cmd_duration_milliseconds{cmdId="ZONE_QUERY_RANK_LIST"} p99/QPS`,
                `场景 F 混合负载:heartbeat 固定 ${formatMs(params.heartbeatIntervalMs)} 独立 timer 触发 (不占 innerLoop 循环槽,不计入 cycle verdict,只写 cmd_error/cmd_rtt metric);battle:rank = ${params.weightBattle}:${params.weightRank} 加权轮转。`,
                `稳态 active_peak 预期 ≈ concurrency × online / (online + offline) = ${params.concurrency} × ${(expectedPcuRatio * 100).toFixed(0)}% ≈ ${expectedActivePeak}。实际值请对照 keyStats.active_peak。`,
                `cycles/failures 来自 Prometheus instant query (run_id=${runId},OTLP push interval 5s,允许 ±5s 计数尾差);RTT 分位见 keyStats / Grafana。`,
            ],
        };
    },
});
