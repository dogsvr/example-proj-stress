// Colyseus battle phase. Joins the room returned by ZONE_START_BATTLE,
// sends fake input on a 100ms tick, optionally collects broadcast frames,
// then leaves. Designed to overlap many bots in the same process.

import { Room } from '@colyseus/sdk';
import type { ZoneStartBattleRes } from 'example-proj/protocols/cmd_proto';
import { cmdRtt, cmdSuccessTotal, cmdErrorTotal, roomsJoined, classifyError } from './otel_metrics_client';
import { startClientSpan } from './otel_tracing_client';
import { sleepUntil, raceAbort, BotAbortError } from './bot_runtime';
import type { Bot } from './bot_login';
import { log } from './log';

export interface BattleSessionOptions {
    /** Battle-end signal: leave after this many ms in the room. Default 8000. */
    durationMs: number;
    /** Send a player-input message every inputIntervalMs. Default 100. */
    inputIntervalMs: number;
    /** Send 'reportKills' just before leave (lockstep room expects this). */
    reportKills: boolean;
}

export const DEFAULT_SESSION: BattleSessionOptions = {
    durationMs: 8000,
    inputIntervalMs: 100,
    reportKills: true,
};

/** Hard cap for room.leave() during shutdown — server may not ack quickly. */
const LEAVE_TIMEOUT_MS = 1500;

/** Run one full battle session: join → tick input → leave. */
export async function runBattleSession(
    bot: Bot,
    syncType: 'state_sync' | 'lockstep_sync',
    opts: BattleSessionOptions = DEFAULT_SESSION,
    abortSignal?: AbortSignal,
): Promise<void> {
    const signal = abortSignal ?? new AbortController().signal;

    const startBattleStart = process.hrtime.bigint();
    const startBattleRes: ZoneStartBattleRes = await raceAbort(bot.startBattle(syncType), signal);
    cmdRtt.record(
        Number(process.hrtime.bigint() - startBattleStart) / 1e6,
        { cmd: 'ZONE_START_BATTLE_to_RES', scenario: bot.scenario },
    );

    const colyseusClient = bot.getColyseusClient(`ws://${bot.endpoints.zonesvrHost}:${startBattleRes.battleSvrAddr}`);
    const roomType = `${syncType}_battle_room`;

    const room = await startClientSpan(
        'bot.COLYSEUS_JOIN',
        { 'colyseus.room_type': roomType, 'bot.syncType': syncType },
        async () => {
            const joinStart = process.hrtime.bigint();
            const joinPromise = colyseusClient.joinOrCreate<unknown>(roomType, { ticket: startBattleRes.ticket });
            // If abort wins the race, a late-resolved Room would schedule ~65s of SDK reconnect timers blocking exit.
            joinPromise.then(
                (orphan) => {
                    if (!signal.aborted) return;
                    const r = orphan as unknown as Room & { reconnection: { enabled: boolean } };
                    r.reconnection.enabled = false;
                    try { r.leave(false); } catch { /* noop */ }
                },
                () => { /* surfaced via raceAbort */ },
            );
            try {
                const r = await raceAbort(joinPromise, signal);
                cmdRtt.record(Number(process.hrtime.bigint() - joinStart) / 1e6, { cmd: 'COLYSEUS_JOIN', scenario: bot.scenario });
                cmdSuccessTotal.add({ cmd: 'COLYSEUS_JOIN', scenario: bot.scenario });
                return r as Room;
            } catch (err) {
                if (err instanceof BotAbortError) throw err;
                cmdErrorTotal.add({ cmd: 'COLYSEUS_JOIN', scenario: bot.scenario, kind: classifyError(err) });
                throw new Error(`colyseus joinOrCreate failed: ${(err as Error).message}`);
            }
        },
    );
    // Disable SDK auto-reconnect: server close codes 1001/ABNORMAL/MAY_TRY_RECONNECT would otherwise hijack onLeave for ~65s.
    (room as unknown as { reconnection: { enabled: boolean } }).reconnection.enabled = false;
    roomsJoined.inc(bot.scenario);

    let leftEarly = false;
    room.onLeave((code) => {
        if (code !== 1000 && code !== 1001) {
            log.debug({ sessionId: room.sessionId, code, scenario: bot.scenario }, 'colyseus onLeave abnormal');
        }
        leftEarly = true;
    });

    room.onMessage('broadcastFrame', () => { /* no-op */ });
    room.onMessage(0, () => { /* lockstep init packet */ });

    const startedAt = Date.now();
    const sendInput = () => {
        if (leftEarly || Date.now() - startedAt >= opts.durationMs) return;
        const t = (Date.now() - startedAt) / 1000;
        const dx = Math.cos(t);
        const dy = Math.sin(t);
        try {
            if (syncType === 'state_sync') {
                room.send(0, { dx, dy });
            } else {
                room.send('submitAction', { vkey: 'input', args: [dx, dy] });
            }
        } catch {
            // send during teardown can throw
        }
    };
    const inputTimer = setInterval(sendInput, opts.inputIntervalMs);

    try {
        await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, opts.durationMs);
            const onAbort = () => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); resolve(); };
            room.onLeave(() => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); resolve(); });
            signal.addEventListener('abort', onAbort, { once: true });
        });
    } finally {
        clearInterval(inputTimer);
    }

    if (!leftEarly) {
        if (opts.reportKills && syncType === 'lockstep_sync' && !signal.aborted) {
            try { room.send('reportKills', 0); } catch { /* noop */ }
        }
        try {
            const leavePromise = room.leave(!signal.aborted);
            await Promise.race([
                leavePromise,
                sleepUntil(LEAVE_TIMEOUT_MS, signal).then(() => undefined),
            ]);
        } catch {
            // leave() can reject if the connection is already gone
        }
    }
    roomsJoined.dec(bot.scenario);

    if (signal.aborted) throw new BotAbortError('battle aborted on shutdown');
}

