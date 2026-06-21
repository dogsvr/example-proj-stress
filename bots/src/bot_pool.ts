// Concurrent bot orchestration: in-process (≤500 bots) or cluster fork (>500).

import * as cluster from 'node:cluster';
import * as os from 'node:os';
import { activeBots, cycleSuccessTotal, cycleFailureTotal, classifyError } from './otel_metrics_client';
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

/** Cleanup: ensure all bots disconnect at scenario end. */
export async function disconnectAll(bots: Bot[]): Promise<void> {
    await Promise.allSettled(bots.map((b) => b.disconnect()));
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
