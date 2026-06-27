// Scenario A: Colyseus battle room capacity ceiling.
// Spawns rooms incrementally; stops when join failure rate exceeds 1%.

import { Bot, DEFAULT_ENDPOINTS } from '../bot_login';
import { runBattleSession } from '../bot_battle';
import { startBotMetrics, stopBotMetrics, sumCounterByLabel } from '../otel_metrics_client';
import { setupBotTracing, shutdownBotTracing } from '../otel_tracing_client';
import { writeReport } from '../report';
import { parseArgs, optNum, optStr, formatMs } from '../cli';
import { log } from '../log';

const SCENARIO = 'a_room_capacity';

interface ScenarioAParams {
    playersPerRoom: number;
    roomsTarget: number;
    roomsStep: number;
    stepIntervalMs: number;
    syncType: 'state_sync' | 'lockstep_sync';
    gidBase: number;
    zoneId: number;
    sessionDurationMs: number;
}

function readParams(): ScenarioAParams {
    const args = parseArgs();
    const sync = optStr(args, 'syncType', 'state_sync');
    if (sync !== 'state_sync' && sync !== 'lockstep_sync') {
        throw new Error(`invalid --syncType ${sync}`);
    }
    return {
        playersPerRoom: optNum(args, 'players-per-room', 8),
        roomsTarget: optNum(args, 'rooms-target', 20),
        roomsStep: optNum(args, 'rooms-step', 1),
        stepIntervalMs: optNum(args, 'step-interval', 30_000),
        syncType: sync,
        gidBase: optNum(args, 'gid-base', 8_000_000),
        zoneId: optNum(args, 'zone-id', 1),
        sessionDurationMs: optNum(args, 'session-duration', 60_000),
    };
}

async function main(): Promise<void> {
    const params = readParams();
    log.info({ params }, `${SCENARIO} starting`);
    setupBotTracing({ serviceName: 'stress-bots' });
    startBotMetrics();

    const startedAt = Date.now();

    let activeBots: Promise<void>[] = [];
    let nextSeq = 0;

    for (let activeRooms = 0; activeRooms < params.roomsTarget; activeRooms += params.roomsStep) {
        const newRooms = Math.min(params.roomsStep, params.roomsTarget - activeRooms);
        const newBots = newRooms * params.playersPerRoom;
        log.info({ activeRooms, newRooms, totalBots: activeBots.length + newBots }, 'ramping rooms');

        for (let b = 0; b < newBots; b++) {
            const seq = nextSeq++;
            activeBots.push(spawnBattleBot(seq, params).catch((err) => {
                log.warn({ err: String(err), seq }, 'bot lifecycle errored');
            }));
        }
        await sleep(params.stepIntervalMs);
    }

    await Promise.all(activeBots);

    const finishedAt = Date.now();
    log.info({ durationMs: finishedAt - startedAt }, `${SCENARIO} finished, writing report`);

    const joinSuccess = sumCounterByLabel('bot_cmd_success_total', 'cmd', 'COLYSEUS_JOIN');
    const joinErrors = sumCounterByLabel('bot_cmd_error_total', 'cmd', 'COLYSEUS_JOIN');
    const totalAttempts = joinSuccess + joinErrors;
    const joinFailRate = totalAttempts > 0 ? joinErrors / totalAttempts : 0;

    const passed = joinFailRate < 0.01;
    await writeReport({
        scenario: SCENARIO,
        startedAt,
        finishedAt,
        params: params as unknown as Record<string, unknown>,
        verdict: {
            passed,
            reason: passed
                ? `Colyseus join 失败率 ${(joinFailRate * 100).toFixed(2)}% < 1% 阈值。tick p99 / eventloop_lag 请查 Grafana dashboard 'Colyseus Battle'。`
                : `Colyseus join 失败率 ${(joinFailRate * 100).toFixed(2)}% > 1% — 房间承载已饱和。`,
            keyStats: {
                'rooms_target': params.roomsTarget,
                'players_per_room': params.playersPerRoom,
                'syncType': params.syncType,
                'duration': formatMs(finishedAt - startedAt),
                'join_attempts': totalAttempts,
                'join_success': joinSuccess,
                'join_errors': joinErrors,
                'join_fail_rate': `${(joinFailRate * 100).toFixed(2)}%`,
            },
        },
        notes: [
            `Grafana 'Colyseus Battle' panel 直接看:\n  - colyseus_tick_duration_milliseconds p99 vs 16.67ms (60fps budget)\n  - colyseus_room_count + colyseus_room_clients\n  - battlesvr nodejs_eventloop_lag_seconds`,
            `若 tick p99 持续超过 16.67ms,场景 A 的真实上限就在该房间数附近。`,
        ],
    });

    await stopBotMetrics();
    await shutdownBotTracing();
}

async function spawnBattleBot(seq: number, params: ScenarioAParams): Promise<void> {
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
        await runBattleSession(bot, params.syncType, {
            durationMs: params.sessionDurationMs,
            inputIntervalMs: 100,
            reportKills: true,
        });
    } finally {
        await bot.disconnect();
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
    log.error({ err: String(err) }, `${SCENARIO} failed`);
    process.exit(1);
});
