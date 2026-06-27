// Concurrent bot orchestration: in-process (≤500 bots) or cluster fork (>500).

import * as cluster from 'node:cluster';
import * as os from 'node:os';
import { activeBots, cycleSuccessTotal, cycleFailureTotal, classifyError } from './otel_metrics_client';
import { driveBot, type BotInnerLoop, type OuterLoopOptions } from './bot_runtime';
import type { Bot } from './bot_login';
import { log } from './log';

export const IN_PROCESS_LIMIT = 500;
export const CLUSTER_HARD_LIMIT = 2000;

export type BotCycle = (botIndex: number) => Promise<void>;

export interface PoolOptions {
    scenario: string;
    concurrency: number;
    /** Total wall-clock duration in ms; set to 0 for run-once (no loop). */
    durationMs: number;
    /** Ramp-up window: spread bot starts evenly over this duration. */
    rampMs?: number;
    /** One bot's lifecycle. Loops until durationMs elapses if durationMs > 0. */
    cycleFn: BotCycle;
}

/** In-process: spin up `concurrency` async tasks, each looping cycleFn. */
export async function runInProcess(opts: PoolOptions): Promise<void> {
    const start = Date.now();
    const stopAt = opts.durationMs > 0 ? start + opts.durationMs : Infinity;
    const ramp = opts.rampMs ?? 0;

    const tasks: Promise<void>[] = [];
    for (let i = 0; i < opts.concurrency; i++) {
        const offsetMs = ramp > 0 ? Math.floor((i * ramp) / opts.concurrency) : 0;
        tasks.push((async () => {
            if (offsetMs > 0) await sleep(offsetMs);
            activeBots.inc(opts.scenario);
            try {
                while (Date.now() < stopAt) {
                    try {
                        await opts.cycleFn(i);
                        cycleSuccessTotal.add({ scenario: opts.scenario });
                    } catch (err) {
                        cycleFailureTotal.add({ scenario: opts.scenario, phase: classifyError(err) });
                        log.warn({ botIndex: i, err: String(err), scenario: opts.scenario }, 'bot cycle failed');
                        await sleep(500 + Math.random() * 500);
                    }
                    if (opts.durationMs <= 0) break;
                }
            } finally {
                activeBots.dec(opts.scenario);
            }
        })());
    }
    await Promise.all(tasks);
}

/**
 * Cluster fork: split `concurrency` across N child processes.
 */
export async function runWithCluster(opts: PoolOptions): Promise<void> {
    const c = cluster as unknown as typeof import('node:cluster').default;
    if (c.isPrimary) {
        const numChildren = Math.max(1, Math.floor(os.cpus().length / 2));
        const perChild = Math.ceil(opts.concurrency / numChildren);
        log.info({ scenario: opts.scenario, numChildren, perChild, total: opts.concurrency }, 'cluster master starting children');

        const children: ReturnType<typeof c.fork>[] = [];
        for (let i = 0; i < numChildren; i++) {
            const env = {
                ...process.env,
                STRESS_CHILD_INDEX: String(i),
                STRESS_CHILD_CONCURRENCY: String(Math.min(perChild, opts.concurrency - i * perChild)),
                STRESS_CHILD_DURATION_MS: String(opts.durationMs),
                STRESS_CHILD_RAMP_MS: String(opts.rampMs ?? 0),
                STRESS_BOTS_PORT: '0',
            };
            children.push(c.fork(env));
        }
        await Promise.all(children.map((ch) =>
            new Promise<void>((resolve) => ch.on('exit', () => resolve())),
        ));
    } else {
        const childOpts: PoolOptions = {
            scenario: opts.scenario,
            concurrency: Number(process.env.STRESS_CHILD_CONCURRENCY) || 1,
            durationMs: Number(process.env.STRESS_CHILD_DURATION_MS) || 0,
            rampMs: Number(process.env.STRESS_CHILD_RAMP_MS) || 0,
            cycleFn: opts.cycleFn,
        };
        await runInProcess(childOpts);
        process.exit(0);
    }
}

export async function runPool(opts: PoolOptions): Promise<void> {
    if (opts.concurrency > CLUSTER_HARD_LIMIT) {
        log.warn({ concurrency: opts.concurrency, limit: CLUSTER_HARD_LIMIT },
            'concurrency exceeds CLUSTER_HARD_LIMIT — data quality degrades when bot CPU competes with server CPU');
    }
    if (opts.concurrency <= IN_PROCESS_LIMIT) {
        await runInProcess(opts);
    } else {
        await runWithCluster(opts);
    }
}

/**
 * Stagger N setup tasks over rampMs (same i*ramp/concurrency offset rule as
 * runInProcess), collect their return values into a positional array.
 * Any setupFn rejection rejects the whole call.
 */
export async function rampedSetup<T>(
    concurrency: number,
    rampMs: number,
    setupFn: (botIndex: number) => Promise<T>,
): Promise<T[]> {
    const tasks: Promise<T>[] = [];
    for (let i = 0; i < concurrency; i++) {
        const offsetMs = rampMs > 0 ? Math.floor((i * rampMs) / concurrency) : 0;
        tasks.push((async () => {
            if (offsetMs > 0) await sleep(offsetMs);
            return setupFn(i);
        })());
    }
    return Promise.all(tasks);
}

/** Cleanup: ensure all bots disconnect at scenario end. */
export async function disconnectAll(bots: Bot[]): Promise<void> {
    await Promise.allSettled(bots.map((b) => b.disconnect()));
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface BotFleetOptions<B extends Bot = Bot> {
    scenario: string;
    concurrency: number;
    durationMs: number;
    rampMs?: number;
    /** Tail window after durationMs for in-flight cycles to finish. Default 15000. */
    gracefulStopMs?: number;
    setupBot: (globalIndex: number) => Promise<B>;
    innerLoop: BotInnerLoop;
    outerLoop?: OuterLoopOptions;
    teardownBot?: (bot: B) => Promise<void>;
    onWorkerInit?: () => Promise<void> | void;
    onWorkerShutdown?: () => Promise<void> | void;
}

/** Top-level fleet driver. Splits primary/worker so the parent never runs setupBot when forking. */
export async function runBotFleet<B extends Bot>(opts: BotFleetOptions<B>): Promise<void> {
    if (opts.concurrency > CLUSTER_HARD_LIMIT) {
        log.warn({ concurrency: opts.concurrency, limit: CLUSTER_HARD_LIMIT },
            'concurrency exceeds CLUSTER_HARD_LIMIT — data quality degrades when bot CPU competes with server CPU');
    }
    const c = cluster as unknown as typeof import('node:cluster').default;

    if (opts.concurrency <= IN_PROCESS_LIMIT) {
        await runFleetWorker(opts, 0, opts.concurrency, opts.rampMs ?? 0, opts.durationMs);
        return;
    }

    if (c.isPrimary) {
        const numChildren = Math.max(1, Math.floor(os.cpus().length / 2));
        const perChild = Math.ceil(opts.concurrency / numChildren);
        log.info({ scenario: opts.scenario, numChildren, perChild, total: opts.concurrency }, 'fleet primary: forking workers');
        log.warn({ scenario: opts.scenario }, 'cluster mode: counterMirror is per-process; primary writeReport will read 0 cycles');

        const children: ReturnType<typeof c.fork>[] = [];
        for (let i = 0; i < numChildren; i++) {
            const env = {
                ...process.env,
                STRESS_CHILD_INDEX: String(i),
                STRESS_CHILD_PER_CHILD: String(perChild),
                STRESS_CHILD_CONCURRENCY: String(Math.min(perChild, opts.concurrency - i * perChild)),
                STRESS_CHILD_DURATION_MS: String(opts.durationMs),
                STRESS_CHILD_RAMP_MS: String(opts.rampMs ?? 0),
                STRESS_BOTS_PORT: '0',
                STRESS_FLEET_WORKER: '1',
            };
            children.push(c.fork(env));
        }
        await Promise.all(children.map((ch) =>
            new Promise<void>((resolve) => ch.on('exit', () => resolve())),
        ));
        return;
    }

    const childIndex = Number(process.env.STRESS_CHILD_INDEX) || 0;
    const perChildSlot = Number(process.env.STRESS_CHILD_PER_CHILD) || 1;
    const localCount = Number(process.env.STRESS_CHILD_CONCURRENCY) || 1;
    const durationMs = Number(process.env.STRESS_CHILD_DURATION_MS) || 0;
    const rampMs = Number(process.env.STRESS_CHILD_RAMP_MS) || 0;
    try {
        await runFleetWorker(opts, childIndex * perChildSlot, localCount, rampMs, durationMs);
    } finally {
        process.exit(0);
    }
}

async function runFleetWorker<B extends Bot>(
    opts: BotFleetOptions<B>,
    globalIndexBase: number,
    localCount: number,
    rampMs: number,
    durationMs: number,
): Promise<void> {
    if (opts.onWorkerInit) await opts.onWorkerInit();

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
        if (opts.onWorkerShutdown) await opts.onWorkerShutdown();
    }
}
