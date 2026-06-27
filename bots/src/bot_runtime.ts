// Per-bot inner/outer-loop driver: runs a BotOperation mix until durationMs elapses.

import type { Bot } from './bot_login';
import { cycleSuccessTotal, cycleFailureTotal, classifyError } from './otel_metrics_client';
import { log } from './log';

export class BotAbortError extends Error {
    constructor(reason = 'aborted') {
        super(reason);
        this.name = 'BotAbortError';
    }
}

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

const RECONNECT_BACKOFF_MS = [200, 500, 1000, 2000, 5000];
const CIRCUIT_BREAK_THRESHOLD = 3;

export const BOT_OP_REGISTRY: Record<string, BotOperation> = {};

export function registerBotOperation(op: BotOperation): void {
    BOT_OP_REGISTRY[op.name] = op;
}

export interface DriveBotOptions {
    scenario: string;
    durationMs: number;
    /** Tail after durationMs: in-flight cycle finishes, no new starts; hard abort at durationMs + gracefulStopMs. Default 15000. */
    gracefulStopMs?: number;
    innerLoop: BotInnerLoop;
    outerLoop?: OuterLoopOptions;
    /** External abort (SIGINT etc); propagates immediately to internal signal. */
    parentAbortSignal?: AbortSignal;
}

export const DEFAULT_GRACEFUL_STOP_MS = 15_000;

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

/** Sleep that resolves early if signal aborts. Never throws. */
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

/** Race a promise against signal abort. Rejects with BotAbortError if signal fires first. */
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

function uniformInt(lo: number, hi: number): number {
    if (hi <= lo) return Math.max(0, lo);
    return Math.floor(lo + Math.random() * (hi - lo));
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
