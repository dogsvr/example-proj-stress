// Common scenario bootstrap: log-start / try-catch-exit / writeReport wrapper.
// Also shared verdict + keyStats helpers for scenarios that verify via Prometheus (B, E).

import { log } from '../log';
import { writeReport, type ScenarioVerdict } from '../report';
import type { FinalStats } from '../prom_query';
import { formatMs } from '../cli';

export interface ScenarioContext<P> {
    scenario: string;
    params: P;
    startedAt: number;
}

export interface ScenarioResult {
    verdict: ScenarioVerdict;
    notes?: string[];
}

export interface ScenarioSpec<P> {
    scenario: string;
    readParams: () => P;
    scenarioTag?: (params: P) => string;
    body: (ctx: ScenarioContext<P>) => Promise<ScenarioResult>;
}

export function runScenario<P>(spec: ScenarioSpec<P>): void {
    (async () => {
        const params = spec.readParams();
        const scenario = spec.scenarioTag ? spec.scenarioTag(params) : spec.scenario;
        log.info({ params }, `${scenario} starting`);
        const startedAt = Date.now();
        const result = await spec.body({ scenario, params, startedAt });
        const finishedAt = Date.now();
        await writeReport({
            scenario,
            startedAt,
            finishedAt,
            params: params as unknown as Record<string, unknown>,
            verdict: result.verdict,
            notes: result.notes,
        });
    })().catch((err) => {
        log.error({ err: String(err) }, `${spec.scenario} failed`);
        process.exit(1);
    });
}

export interface PromVerdictOptions {
    threshold: number;
    ok: (ratePct: string) => string;
    fail: (ratePct: string) => string;
    inconclusive: (reason: string) => string;
}

export interface PromVerdict {
    passed: boolean;
    errorRate: number;
    reason: string;
}

export function verdictFromPromStats(stats: FinalStats, opts: PromVerdictOptions): PromVerdict {
    if (!stats.ok) {
        return { passed: false, errorRate: 0, reason: opts.inconclusive(stats.reason) };
    }
    const total = stats.cyclesTotal + stats.failuresTotal;
    const errorRate = total > 0 ? stats.failuresTotal / total : 0;
    const passed = total > 0 && errorRate < opts.threshold;
    const ratePct = `${(errorRate * 100).toFixed(2)}%`;
    return { passed, errorRate, reason: passed ? opts.ok(ratePct) : opts.fail(ratePct) };
}

export function promStatsKeyStats(
    stats: FinalStats,
    base: Record<string, string | number>,
    errorRate: number,
): Record<string, string | number> {
    if (!stats.ok) {
        return { ...base, 'cycles_total': 'n/a (prom query failed)', 'error_rate': 'n/a' };
    }
    return {
        ...base,
        'cycles_total': stats.cyclesTotal + stats.failuresTotal,
        'cycles_success': stats.cyclesTotal,
        'cycles_failure': stats.failuresTotal,
        'error_rate': `${(errorRate * 100).toFixed(2)}%`,
        'rtt_p50_ms': stats.rttP50?.toFixed(2) ?? 'n/a',
        'rtt_p95_ms': stats.rttP95?.toFixed(2) ?? 'n/a',
        'rtt_p99_ms': stats.rttP99?.toFixed(2) ?? 'n/a',
        'active_peak': stats.activePeak ?? 'n/a',
        'cycles_by_op': JSON.stringify(stats.cyclesByOp),
        'failures_by_phase': JSON.stringify(stats.failuresByPhase),
    };
}

export function getRunId(): string {
    return process.env.STRESS_RUN_ID ?? `pid-${process.pid}`;
}

// Re-export formatMs so scenarios only import from one shell module for framing helpers.
export { formatMs };
