// Query Prometheus for final scenario counters when in-process counterMirror
// can't see worker-side data (cluster fork). Uses run_id as resource attribute
// so multi-run queries don't bleed into each other.

import { log } from './log';

const DEFAULT_PROM_BASE = 'http://127.0.0.1:9090';
const FLUSH_GRACE_MS = 2000;
const RETRY_COUNT = 6;
const RETRY_INTERVAL_MS = 1000;
const HTTP_TIMEOUT_MS = 3000;

export interface FinalStatsOk {
    ok: true;
    cyclesTotal: number;
    failuresTotal: number;
    failuresByPhase: Record<string, number>;
    cyclesByOp: Record<string, number>;
    rttP50: number | null;
    rttP95: number | null;
    rttP99: number | null;
    activePeak: number | null;
}

export interface FinalStatsErr {
    ok: false;
    reason: string;
}

export type FinalStats = FinalStatsOk | FinalStatsErr;

export interface QueryFinalCountersInput {
    scenario: string;
    runId: string;
    startedAt: number;
    finishedAt: number;
    promBaseUrl?: string;
}

export async function queryFinalCounters(input: QueryFinalCountersInput): Promise<FinalStats> {
    const base = input.promBaseUrl ?? process.env.STRESS_PROM_BASE ?? DEFAULT_PROM_BASE;
    const labelSel = `{run_id="${escapeLabel(input.runId)}",scenario="${escapeLabel(input.scenario)}"}`;
    const windowSec = Math.max(10, Math.ceil((input.finishedAt - input.startedAt) / 1000) + 10);
    const queryTime = Math.floor(input.finishedAt / 1000);

    await sleep(FLUSH_GRACE_MS);

    let lastErr: string = '';
    for (let attempt = 0; attempt < RETRY_COUNT; attempt++) {
        try {
            const cyclesScalar = await queryScalar(base, `sum(bot_cycle_success_total${labelSel})`, queryTime);
            const failuresScalar = await queryScalar(base, `sum(bot_cycle_failure_total${labelSel})`, queryTime);

            if (cyclesScalar === null && failuresScalar === null) {
                lastErr = 'cycles + failures both null';
            } else if ((cyclesScalar ?? 0) + (failuresScalar ?? 0) <= 0) {
                lastErr = `cycles=${cyclesScalar} failures=${failuresScalar}, total ≤ 0`;
            } else {
                const [byPhase, byOp, p50, p95, p99, peak] = await Promise.all([
                    queryGroupBy(base, `sum by (phase) (bot_cycle_failure_total${labelSel})`, queryTime, 'phase'),
                    queryGroupBy(base, `sum by (op) (bot_cycle_success_total${labelSel})`, queryTime, 'op'),
                    queryScalar(base, rttQuantile(0.50, labelSel, windowSec), queryTime),
                    queryScalar(base, rttQuantile(0.95, labelSel, windowSec), queryTime),
                    queryScalar(base, rttQuantile(0.99, labelSel, windowSec), queryTime),
                    queryScalar(base, `max_over_time(bot_active_count${labelSel}[${windowSec}s])`, queryTime),
                ]);
                return {
                    ok: true,
                    cyclesTotal: cyclesScalar ?? 0,
                    failuresTotal: failuresScalar ?? 0,
                    failuresByPhase: byPhase,
                    cyclesByOp: byOp,
                    rttP50: p50,
                    rttP95: p95,
                    rttP99: p99,
                    activePeak: peak,
                };
            }
        } catch (err) {
            lastErr = String((err as { message?: string })?.message ?? err);
        }
        log.warn({ attempt: attempt + 1, retryAfterMs: RETRY_INTERVAL_MS, lastErr }, 'prom_query: empty/failed, retrying');
        await sleep(RETRY_INTERVAL_MS);
    }
    return { ok: false, reason: `Prometheus query exhausted ${RETRY_COUNT} retries: ${lastErr}` };
}

function rttQuantile(q: number, labelSel: string, windowSec: number): string {
    return `histogram_quantile(${q}, sum by (le) (rate(bot_cmd_rtt_milliseconds_bucket${labelSel}[${windowSec}s])))`;
}

async function queryScalar(base: string, promql: string, time: number): Promise<number | null> {
    const data = await rawQuery(base, promql, time);
    const result = data?.data?.result;
    if (!Array.isArray(result) || result.length === 0) return null;
    const v = result[0]?.value?.[1];
    if (v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

async function queryGroupBy(base: string, promql: string, time: number, labelKey: string): Promise<Record<string, number>> {
    const data = await rawQuery(base, promql, time);
    const result = data?.data?.result;
    const out: Record<string, number> = {};
    if (!Array.isArray(result)) return out;
    for (const r of result) {
        const k = r?.metric?.[labelKey] ?? 'unknown';
        const v = Number(r?.value?.[1]);
        if (Number.isFinite(v)) out[k] = v;
    }
    return out;
}

async function rawQuery(base: string, promql: string, time: number): Promise<any> {
    const url = `${base}/api/v1/query?query=${encodeURIComponent(promql)}&time=${time}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();
    if (json?.status !== 'success') throw new Error(`prom status=${json?.status}`);
    return json;
}

function escapeLabel(s: string): string {
    return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
