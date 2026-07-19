// Bot fleet driver.
//
// runBotFleet(opts): drive `concurrency` bots for `durationMs` with `rampMs`
// ramp-up. ≤ IN_PROCESS_LIMIT (500) = one process, 1 shard; above forks
// cpus/2 child processes, N shards.
//
// Each shard: ramped setupBot → driveBot (BotOperation inner-loop, optional
// relogin outer-loop) → teardown. Setup failure skips one bot, not the shard.
// Stop: no new cycles after durationMs; hard abort at +gracefulStopMs (15s).
// SIGINT/SIGTERM = graceful abort; second signal = force-exit(130).

import * as cluster from 'node:cluster';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import { activeBots, cycleSuccessTotal, cycleFailureTotal, classifyError } from './otel_client';
import type { Bot } from './bot';
import { log } from './log';

export const IN_PROCESS_LIMIT = 500;
export const CLUSTER_HARD_LIMIT = 2000;
export const DEFAULT_GRACEFUL_STOP_MS = 15_000;

const RECONNECT_BACKOFF_MS = [200, 500, 1000, 2000, 5000];
const CIRCUIT_BREAK_THRESHOLD = 3;

// ---- Abort primitives -----------------------------------------------------

export class BotAbortError extends Error {
    constructor(reason = 'aborted') {
        super(reason);
        this.name = 'BotAbortError';
    }
}

export function sleepUntil(ms: number, signal: AbortSignal): Promise<void> {
    if (ms <= 0 || signal.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            resolve();
        };
        signal.addEventListener('abort', onAbort, { once: true });
    });
}

export function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) {
        return Promise.reject(new BotAbortError(String((signal.reason as Error)?.message ?? 'aborted')));
    }
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(new BotAbortError(String((signal.reason as Error)?.message ?? 'aborted')));
        signal.addEventListener('abort', onAbort, { once: true });
        p.then(
            (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
            (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
        );
    });
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- Reconnect ------------------------------------------------------------

export async function reconnectWithBackoff(bot: Bot): Promise<void> {
    let attempt = 0;
    let lastErr: unknown;
    while (attempt <= RECONNECT_BACKOFF_MS.length) {
        try {
            await bot.reconnect();
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

// ---- Per-bot driver -------------------------------------------------------

export interface OpContext {
    botIndex: number;
    iteration: number;
    scenario: string;
    elapsedMs: number;
    abortSignal: AbortSignal;
}

export interface BotOperation {
    name: string;
    run: (bot: Bot, ctx: OpContext) => Promise<void>;
    weight?: number;
}

export type BotInnerLoop =
    | { kind: 'sequence'; ops: BotOperation[]; jitterMs?: [number, number] }
    | { kind: 'weighted'; ops: BotOperation[]; jitterMs?: [number, number] };

export type OuterLoopOptions =
    | { kind: 'persistent' }
    | { kind: 'cycles'; everyN: number }
    | { kind: 'time'; everyMs: number };

export const DEFAULT_OUTER_LOOP: OuterLoopOptions = { kind: 'persistent' };

export interface DriveBotOptions {
    scenario: string;
    durationMs: number;
    gracefulStopMs?: number;
    innerLoop: BotInnerLoop;
    outerLoop?: OuterLoopOptions;
    parentAbortSignal?: AbortSignal;
}

export async function driveBot(
    bot: Bot,
    botIndex: number,
    opts: DriveBotOptions,
): Promise<void> {
    if (opts.innerLoop.ops.length === 0) {
        throw new Error('innerLoop.ops must not be empty');
    }
    const startedAt = Date.now();
    const stopAt = opts.durationMs > 0 ? startedAt + opts.durationMs : Infinity;
    const gracefulMs = Math.max(0, opts.gracefulStopMs ?? DEFAULT_GRACEFUL_STOP_MS);
    const hardAt = Number.isFinite(stopAt) ? stopAt + gracefulMs : Infinity;
    const outer = opts.outerLoop ?? DEFAULT_OUTER_LOOP;
    const jitter = opts.innerLoop.jitterMs;

    const abortCtl = new AbortController();
    const hardTimer = Number.isFinite(hardAt)
        ? setTimeout(() => abortCtl.abort(new BotAbortError('hard_stop')), hardAt - Date.now())
        : null;
    if (hardTimer && typeof hardTimer.unref === 'function') hardTimer.unref();

    let parentAbortListener: (() => void) | null = null;
    if (opts.parentAbortSignal) {
        if (opts.parentAbortSignal.aborted) {
            abortCtl.abort(new BotAbortError('parent_aborted'));
        } else {
            parentAbortListener = () => abortCtl.abort(new BotAbortError('parent_aborted'));
            opts.parentAbortSignal.addEventListener('abort', parentAbortListener, { once: true });
        }
    }

    let iteration = 0;
    let consecErr = 0;
    let cyclesSinceRelogin = 0;
    let lastReloginAt = startedAt;

    try {
        while (Date.now() < stopAt && !abortCtl.signal.aborted) {
            const op = pickOp(opts.innerLoop, iteration);
            const elapsedMs = Date.now() - startedAt;
            const ctx: OpContext = { botIndex, iteration, scenario: opts.scenario, elapsedMs, abortSignal: abortCtl.signal };

            try {
                await op.run(bot, ctx);
                cycleSuccessTotal.add({ scenario: opts.scenario, op: op.name });
                consecErr = 0;
            } catch (err) {
                if (abortCtl.signal.aborted) {
                    log.info({ botIndex, op: op.name, scenario: opts.scenario, iteration, err: String(err) }, 'bot op aborted on shutdown');
                    break;
                }
                cycleFailureTotal.add({ scenario: opts.scenario, op: op.name, phase: classifyError(err) });
                log.warn({ botIndex, op: op.name, scenario: opts.scenario, iteration, err: String(err) }, 'bot op failed');
                if (++consecErr >= CIRCUIT_BREAK_THRESHOLD) {
                    try {
                        await reconnectWithBackoff(bot);
                        consecErr = 0;
                        lastReloginAt = Date.now();
                        cyclesSinceRelogin = 0;
                    } catch (reErr) {
                        log.error({ botIndex, scenario: opts.scenario, err: String(reErr) }, 'circuit-break reconnect failed; aborting bot');
                        return;
                    }
                }
            }

            iteration++;
            cyclesSinceRelogin++;
            if (abortCtl.signal.aborted || Date.now() >= stopAt) break;

            if (shouldRelogin(outer, cyclesSinceRelogin, Date.now() - lastReloginAt)) {
                try {
                    await reconnectWithBackoff(bot);
                    cyclesSinceRelogin = 0;
                    lastReloginAt = Date.now();
                } catch (reErr) {
                    log.error({ botIndex, scenario: opts.scenario, err: String(reErr) }, 'outer-loop relogin failed; aborting bot');
                    return;
                }
            }

            if (jitter && !abortCtl.signal.aborted && Date.now() < stopAt) {
                await sleepUntil(uniformInt(jitter[0], jitter[1]), abortCtl.signal);
            }
        }
    } finally {
        if (hardTimer) clearTimeout(hardTimer);
        if (parentAbortListener && opts.parentAbortSignal) {
            opts.parentAbortSignal.removeEventListener('abort', parentAbortListener);
        }
    }
}

function pickOp(loop: BotInnerLoop, iteration: number): BotOperation {
    if (loop.kind === 'sequence') {
        return loop.ops[iteration % loop.ops.length];
    }
    let totalWeight = 0;
    for (const op of loop.ops) totalWeight += Math.max(0, op.weight ?? 1);
    if (totalWeight <= 0) return loop.ops[0];
    let r = Math.random() * totalWeight;
    for (const op of loop.ops) {
        const w = Math.max(0, op.weight ?? 1);
        r -= w;
        if (r <= 0) return op;
    }
    return loop.ops[loop.ops.length - 1];
}

function shouldRelogin(outer: OuterLoopOptions, cyclesSinceRelogin: number, msSinceRelogin: number): boolean {
    switch (outer.kind) {
        case 'persistent': return false;
        case 'cycles': return outer.everyN > 0 && cyclesSinceRelogin >= outer.everyN;
        case 'time': return outer.everyMs > 0 && msSinceRelogin >= outer.everyMs;
    }
}

function uniformInt(lo: number, hi: number): number {
    if (hi <= lo) return Math.max(0, lo);
    return Math.floor(lo + Math.random() * (hi - lo));
}

// ---- Fleet driver ---------------------------------------------------------

function ensureRunId(): string {
    if (!process.env.STRESS_RUN_ID) {
        process.env.STRESS_RUN_ID = randomUUID();
    }
    return process.env.STRESS_RUN_ID;
}

export interface BotFleetOptions<B extends Bot = Bot> {
    scenario: string;
    concurrency: number;
    durationMs: number;
    rampMs?: number;
    gracefulStopMs?: number;
    setupBot: (globalIndex: number) => Promise<B>;
    innerLoop: BotInnerLoop;
    outerLoop?: OuterLoopOptions;
    teardownBot?: (bot: B) => Promise<void>;
    onShardInit?: () => Promise<void> | void;
    onShardShutdown?: () => Promise<void> | void;
}

export async function runBotFleet<B extends Bot>(opts: BotFleetOptions<B>): Promise<void> {
    if (opts.concurrency > CLUSTER_HARD_LIMIT) {
        log.warn({ concurrency: opts.concurrency, limit: CLUSTER_HARD_LIMIT },
            'concurrency exceeds CLUSTER_HARD_LIMIT — data quality degrades when bot CPU competes with server CPU');
    }
    const c = cluster as unknown as typeof import('node:cluster').default;

    if (opts.concurrency <= IN_PROCESS_LIMIT) {
        ensureRunId();
        await runFleetShard(opts, 0, opts.concurrency, opts.rampMs ?? 0, opts.durationMs);
        return;
    }

    if (c.isPrimary) {
        ensureRunId();
        const numShards = Math.max(1, Math.floor(os.cpus().length / 2));
        const perShard = Math.ceil(opts.concurrency / numShards);
        log.info({ scenario: opts.scenario, numShards, perShard, total: opts.concurrency }, 'fleet primary: forking shards');

        const children: ReturnType<typeof c.fork>[] = [];
        for (let i = 0; i < numShards; i++) {
            const env = {
                ...process.env,
                STRESS_SHARD_PER_SHARD: String(perShard),
                STRESS_SHARD_CONCURRENCY: String(Math.min(perShard, opts.concurrency - i * perShard)),
                STRESS_SHARD_DURATION_MS: String(opts.durationMs),
                STRESS_SHARD_RAMP_MS: String(opts.rampMs ?? 0),
                STRESS_FLEET_SHARD: '1',
                STRESS_SHARD_INDEX: String(i),
            };
            children.push(c.fork(env));
        }
        await Promise.all(children.map((ch) =>
            new Promise<void>((resolve) => ch.on('exit', () => resolve())),
        ));
        return;
    }

    const shardIndex = Number(process.env.STRESS_SHARD_INDEX) || 0;
    const perShardSlot = Number(process.env.STRESS_SHARD_PER_SHARD) || 1;
    const localCount = Number(process.env.STRESS_SHARD_CONCURRENCY) || 1;
    const durationMs = Number(process.env.STRESS_SHARD_DURATION_MS) || 0;
    const rampMs = Number(process.env.STRESS_SHARD_RAMP_MS) || 0;
    try {
        await runFleetShard(opts, shardIndex * perShardSlot, localCount, rampMs, durationMs);
    } finally {
        process.exit(0);
    }
}

async function runFleetShard<B extends Bot>(
    opts: BotFleetOptions<B>,
    globalIndexBase: number,
    localCount: number,
    rampMs: number,
    durationMs: number,
): Promise<void> {
    if (opts.onShardInit) await opts.onShardInit();

    const teardown = opts.teardownBot ?? ((b: B) => b.disconnect());
    const startedAt = Date.now();
    const stopAt = startedAt + durationMs;
    const setupBots: B[] = [];

    const sigCtl = new AbortController();
    const onSig = () => {
        if (!sigCtl.signal.aborted) {
            log.warn({ scenario: opts.scenario }, 'SIGINT/SIGTERM received; aborting all bots (Ctrl+C again to force-exit)');
            sigCtl.abort();
        } else {
            log.error({ scenario: opts.scenario }, 'second SIGINT/SIGTERM; force-exiting');
            process.exit(130);
        }
    };
    process.on('SIGINT', onSig);
    process.on('SIGTERM', onSig);

    try {
        const tasks: Promise<void>[] = [];
        for (let i = 0; i < localCount; i++) {
            const localI = i;
            const globalIndex = globalIndexBase + localI;
            const offsetMs = rampMs > 0 ? Math.floor((localI * rampMs) / localCount) : 0;
            tasks.push((async () => {
                if (offsetMs > 0) await sleep(offsetMs);
                if (sigCtl.signal.aborted) return;
                let bot: B;
                try {
                    bot = await opts.setupBot(globalIndex);
                } catch (err) {
                    log.warn({ globalIndex, scenario: opts.scenario, err: String(err) }, 'setupBot failed; skipping bot');
                    return;
                }
                setupBots.push(bot);

                const remaining = stopAt - Date.now();
                if (remaining <= 0 || sigCtl.signal.aborted) return;

                activeBots.inc(opts.scenario);
                try {
                    await driveBot(bot, globalIndex, {
                        scenario: opts.scenario,
                        durationMs: remaining,
                        gracefulStopMs: opts.gracefulStopMs,
                        innerLoop: opts.innerLoop,
                        outerLoop: opts.outerLoop,
                        parentAbortSignal: sigCtl.signal,
                    });
                } catch (err) {
                    log.error({ globalIndex, scenario: opts.scenario, err: String(err) }, 'driveBot crashed');
                } finally {
                    activeBots.dec(opts.scenario);
                }
            })());
        }
        await Promise.all(tasks);
    } finally {
        process.removeListener('SIGINT', onSig);
        process.removeListener('SIGTERM', onSig);
        await Promise.allSettled(setupBots.map((b) => teardown(b)));
        if (opts.onShardShutdown) await opts.onShardShutdown();
    }
}
