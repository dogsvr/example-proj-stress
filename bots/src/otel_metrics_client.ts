// Client metrics for stress bots via OpenTelemetry SDK + PrometheusExporter.
// Plain-counter mirror enables synchronous reads for scenario verdict logic.

import { metrics, type Counter, type Histogram, type UpDownCounter } from '@opentelemetry/api';
import { MeterProvider, AggregationType } from '@opentelemetry/sdk-metrics';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { resourceFromAttributes } from '@opentelemetry/resources';

const RTT_BUCKETS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];

let provider: MeterProvider | null = null;

let cmdRttHist: Histogram | null = null;
let cmdErrorHist: Counter | null = null;
let cmdSuccessHist: Counter | null = null;
let cycleSuccessHist: Counter | null = null;
let cycleFailureHist: Counter | null = null;
let activeBotsGauge: UpDownCounter | null = null;
let roomsJoinedGauge: UpDownCounter | null = null;

const counterMirror = new Map<string, number>();
const labelsMirror = new Map<string, Record<string, string>>();

function bumpMirror(name: string, labels: Record<string, string>, delta: number): void {
    const key = name + '|' + JSON.stringify(labels);
    counterMirror.set(key, (counterMirror.get(key) ?? 0) + delta);
    if (!labelsMirror.has(key)) labelsMirror.set(key, labels);
}

/** Aggregate snapshot of plain mirror. Each entry is one (metric, labels) bucket. */
export interface CounterSnapshot {
    name: string;
    labels: Record<string, string>;
    value: number;
}

export function snapshotCounters(): CounterSnapshot[] {
    const out: CounterSnapshot[] = [];
    for (const [key, value] of counterMirror) {
        const sep = key.indexOf('|');
        const name = key.slice(0, sep);
        out.push({ name, labels: labelsMirror.get(key) ?? {}, value });
    }
    return out;
}

/** Sum across all label-tuples for a given metric name. */
export function sumCounter(name: string): number {
    let s = 0;
    const prefix = name + '|';
    for (const [k, v] of counterMirror) {
        if (k.startsWith(prefix)) s += v;
    }
    return s;
}

/** Sum across counter buckets where label[key] === value. */
export function sumCounterByLabel(name: string, key: string, value: string): number {
    let s = 0;
    for (const entry of snapshotCounters()) {
        if (entry.name !== name) continue;
        if (entry.labels[key] === value) s += entry.value;
    }
    return s;
}

/** Group counter values by label[key]; returns { labelValue: sum }. */
export function collectByLabel(name: string, key: string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const entry of snapshotCounters()) {
        if (entry.name !== name) continue;
        const k = entry.labels[key] ?? 'unknown';
        out[k] = (out[k] ?? 0) + entry.value;
    }
    return out;
}

export function startBotMetricsEndpoint(port = Number(process.env.STRESS_BOTS_PORT) || 9201): void {
    if (provider) return;

    const exporter = new PrometheusExporter({
        host: '127.0.0.1',
        port,
        endpoint: '/metrics',
        appendTimestamp: false,
    });

    provider = new MeterProvider({
        resource: resourceFromAttributes({ 'service.name': 'stress-bots' }),
        readers: [exporter],
        views: [
            {
                instrumentName: 'bot_cmd_rtt_ms',
                aggregation: { type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM, options: { boundaries: RTT_BUCKETS } },
            },
        ],
    });
    metrics.setGlobalMeterProvider(provider);

    const meter = metrics.getMeter('stress-bots');
    cmdRttHist        = meter.createHistogram('bot_cmd_rtt_ms',          { description: 'Round-trip latency observed by bots, by cmd label.', unit: 'ms' });
    cmdErrorHist      = meter.createCounter('bot_cmd_error_total',       { description: 'Bot-side errors (timeout / disconnect / server_error / unknown).' });
    cmdSuccessHist    = meter.createCounter('bot_cmd_success_total',     { description: 'Bot-side successful calls.' });
    cycleSuccessHist  = meter.createCounter('bot_cycle_success_total',   { description: 'Full login→battle→end cycles completed without error.' });
    cycleFailureHist  = meter.createCounter('bot_cycle_failure_total',   { description: 'Full cycles aborted by an error.' });
    activeBotsGauge   = meter.createUpDownCounter('bot_active_count',    { description: 'Active bots currently running.' });
    roomsJoinedGauge  = meter.createUpDownCounter('bot_rooms_joined',    { description: 'Bots currently inside a Colyseus room.' });
}

export async function stopBotMetricsEndpoint(): Promise<void> {
    await provider?.shutdown();
    provider = null;
}

// ---- Helper API (record/inc shape). ----

export const cmdRtt = {
    record(ms: number, attrs: { cmd: string; scenario: string }): void {
        cmdRttHist?.record(ms, attrs);
    },
};

export const cmdErrorTotal = {
    add(attrs: { cmd: string; scenario: string; kind: string }): void {
        cmdErrorHist?.add(1, attrs);
        bumpMirror('bot_cmd_error_total', attrs, 1);
    },
};

export const cmdSuccessTotal = {
    add(attrs: { cmd: string; scenario: string }): void {
        cmdSuccessHist?.add(1, attrs);
        bumpMirror('bot_cmd_success_total', attrs, 1);
    },
};

export const cycleSuccessTotal = {
    add(attrs: { scenario: string; op?: string }): void {
        cycleSuccessHist?.add(1, attrs);
        bumpMirror('bot_cycle_success_total', attrs as Record<string, string>, 1);
    },
};

export const cycleFailureTotal = {
    add(attrs: { scenario: string; phase: string; op?: string }): void {
        cycleFailureHist?.add(1, attrs);
        bumpMirror('bot_cycle_failure_total', attrs as Record<string, string>, 1);
    },
};

export const activeBots = {
    inc(scenario: string): void { activeBotsGauge?.add(1, { scenario }); },
    dec(scenario: string): void { activeBotsGauge?.add(-1, { scenario }); },
};

export const roomsJoined = {
    inc(scenario: string): void { roomsJoinedGauge?.add(1, { scenario }); },
    dec(scenario: string): void { roomsJoinedGauge?.add(-1, { scenario }); },
};

/** Classify a thrown error / disconnect into one of the kind labels. */
export function classifyError(err: unknown): 'timeout' | 'disconnect' | 'server_error' | 'unknown' {
    const msg = String((err as { message?: string })?.message ?? err ?? '').toLowerCase();
    if (msg.includes('timeout')) return 'timeout';
    if (msg.includes('disconnect') || msg.includes('closed') || msg.includes('econnrefused') || msg.includes('econnreset')) return 'disconnect';
    if (msg.includes('errcode') || msg.includes('not authorized') || msg.includes('invalid')) return 'server_error';
    return 'unknown';
}
