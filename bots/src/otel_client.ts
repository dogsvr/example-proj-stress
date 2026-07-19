// Bot-side OpenTelemetry client: metrics (OTLP push) + tracing (OTLP batch).
// Plain-counter mirror enables synchronous reads for in-process scenario verdicts;
// cluster-mode scenarios read final counters from Prometheus (see prom_query.ts).

import {
    metrics, context, propagation, trace,
    SpanKind, SpanStatusCode,
    type Counter, type Histogram, type UpDownCounter, type Span,
} from '@opentelemetry/api';
import { MeterProvider, AggregationType, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { NodeTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';

const DEFAULT_OTLP_ENDPOINT_BASE = 'http://localhost:4318';
const TRACER_NAME = 'stress-bots';
const RTT_BUCKETS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];

// ---- Providers ------------------------------------------------------------

let meterProvider: MeterProvider | null = null;
let tracerProvider: NodeTracerProvider | null = null;
let runId = '';

let cmdRttHist: Histogram | null = null;
let cmdErrorHist: Counter | null = null;
let cmdSuccessHist: Counter | null = null;
let cycleSuccessHist: Counter | null = null;
let cycleFailureHist: Counter | null = null;
let activeBotsGauge: UpDownCounter | null = null;
let roomsJoinedGauge: UpDownCounter | null = null;

export interface TelemetryOptions {
    serviceName?: string;
    otlpBase?: string;
    resourceAttributes?: Record<string, string>;
}

function makeResource(opts: TelemetryOptions) {
    return resourceFromAttributes({
        'service.name': opts.serviceName ?? 'stress-bots',
        ...(opts.resourceAttributes ?? {}),
    });
}

// ---- Metrics --------------------------------------------------------------

const counterMirror = new Map<string, number>();
const labelsMirror = new Map<string, Record<string, string>>();

function bumpMirror(name: string, labels: Record<string, string>, delta: number): void {
    const key = name + '|' + JSON.stringify(labels);
    counterMirror.set(key, (counterMirror.get(key) ?? 0) + delta);
    if (!labelsMirror.has(key)) labelsMirror.set(key, labels);
}

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

export function sumCounter(name: string): number {
    let s = 0;
    const prefix = name + '|';
    for (const [k, v] of counterMirror) {
        if (k.startsWith(prefix)) s += v;
    }
    return s;
}

export function sumCounterByLabel(name: string, key: string, value: string): number {
    let s = 0;
    for (const entry of snapshotCounters()) {
        if (entry.name !== name) continue;
        if (entry.labels[key] === value) s += entry.value;
    }
    return s;
}

export function collectByLabel(name: string, key: string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const entry of snapshotCounters()) {
        if (entry.name !== name) continue;
        const k = entry.labels[key] ?? 'unknown';
        out[k] = (out[k] ?? 0) + entry.value;
    }
    return out;
}

function startMetrics(opts: TelemetryOptions): void {
    if (meterProvider) return;
    const url = (opts.otlpBase ?? process.env.STRESS_BOTS_OTLP_ENDPOINT ?? DEFAULT_OTLP_ENDPOINT_BASE) + '/v1/metrics';
    const exporter = new OTLPMetricExporter({ url });
    runId = process.env.STRESS_RUN_ID ?? `pid-${process.pid}`;

    meterProvider = new MeterProvider({
        resource: makeResource(opts),
        readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 5000 })],
        views: [
            {
                instrumentName: 'bot_cmd_rtt',
                aggregation: { type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM, options: { boundaries: RTT_BUCKETS } },
            },
        ],
    });
    metrics.setGlobalMeterProvider(meterProvider);

    const meter = metrics.getMeter('stress-bots');
    cmdRttHist       = meter.createHistogram('bot_cmd_rtt',           { description: 'Round-trip latency observed by bots, by cmd label.', unit: 'ms' });
    cmdErrorHist     = meter.createCounter('bot_cmd_error_total',     { description: 'Bot-side errors (timeout / disconnect / server_error / unknown).' });
    cmdSuccessHist   = meter.createCounter('bot_cmd_success_total',   { description: 'Bot-side successful calls.' });
    cycleSuccessHist = meter.createCounter('bot_cycle_success_total', { description: 'Full login→battle→end cycles completed without error.' });
    cycleFailureHist = meter.createCounter('bot_cycle_failure_total', { description: 'Full cycles aborted by an error.' });
    activeBotsGauge  = meter.createUpDownCounter('bot_active_count',  { description: 'Active bots currently running.' });
    roomsJoinedGauge = meter.createUpDownCounter('bot_rooms_joined',  { description: 'Bots currently inside a Colyseus room.' });
}

async function stopMetrics(): Promise<void> {
    await meterProvider?.shutdown();
    meterProvider = null;
}

export const cmdRtt = {
    record(ms: number, attrs: { cmd: string; scenario: string }): void {
        cmdRttHist?.record(ms, { ...attrs, run_id: runId });
    },
};

export const cmdErrorTotal = {
    add(attrs: { cmd: string; scenario: string; kind: string }): void {
        const a = { ...attrs, run_id: runId };
        cmdErrorHist?.add(1, a);
        bumpMirror('bot_cmd_error_total', a, 1);
    },
};

export const cmdSuccessTotal = {
    add(attrs: { cmd: string; scenario: string }): void {
        const a = { ...attrs, run_id: runId };
        cmdSuccessHist?.add(1, a);
        bumpMirror('bot_cmd_success_total', a, 1);
    },
};

export const cycleSuccessTotal = {
    add(attrs: { scenario: string; op?: string }): void {
        const a = { ...attrs, run_id: runId } as Record<string, string>;
        cycleSuccessHist?.add(1, a);
        bumpMirror('bot_cycle_success_total', a, 1);
    },
};

export const cycleFailureTotal = {
    add(attrs: { scenario: string; phase: string; op?: string }): void {
        const a = { ...attrs, run_id: runId } as Record<string, string>;
        cycleFailureHist?.add(1, a);
        bumpMirror('bot_cycle_failure_total', a, 1);
    },
};

export const activeBots = {
    inc(scenario: string): void { activeBotsGauge?.add(1, { scenario, run_id: runId }); },
    dec(scenario: string): void { activeBotsGauge?.add(-1, { scenario, run_id: runId }); },
};

export const roomsJoined = {
    inc(scenario: string): void { roomsJoinedGauge?.add(1, { scenario, run_id: runId }); },
    dec(scenario: string): void { roomsJoinedGauge?.add(-1, { scenario, run_id: runId }); },
};

export function classifyError(err: unknown): 'timeout' | 'disconnect' | 'server_error' | 'unknown' {
    const msg = String((err as { message?: string })?.message ?? err ?? '').toLowerCase();
    if (msg.includes('timeout')) return 'timeout';
    if (msg.includes('disconnect') || msg.includes('closed') || msg.includes('econnrefused') || msg.includes('econnreset')) return 'disconnect';
    if (msg.includes('errcode') || msg.includes('not authorized') || msg.includes('invalid')) return 'server_error';
    return 'unknown';
}

// ---- Tracing --------------------------------------------------------------

function startTracing(opts: TelemetryOptions): void {
    if (tracerProvider) return;
    const url = (opts.otlpBase ?? process.env.STRESS_BOTS_OTLP_ENDPOINT ?? DEFAULT_OTLP_ENDPOINT_BASE) + '/v1/traces';
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
    tracerProvider = new NodeTracerProvider({
        resource: makeResource(opts),
        spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url }))],
    });
    trace.setGlobalTracerProvider(tracerProvider);
}

async function stopTracing(): Promise<void> {
    await tracerProvider?.shutdown();
    tracerProvider = null;
}

export async function startClientSpan<T>(
    name: string,
    attrs: Record<string, string | number | boolean>,
    fn: () => Promise<T>,
): Promise<T> {
    const tracer = trace.getTracer(TRACER_NAME);
    return tracer.startActiveSpan(name, { kind: SpanKind.CLIENT, attributes: attrs }, async (span: Span) => {
        try {
            const r = await fn();
            span.end();
            return r;
        } catch (err) {
            span.recordException(err as Error);
            span.setStatus({ code: SpanStatusCode.ERROR });
            span.end();
            throw err;
        }
    });
}

export function injectTraceHead<T extends Record<string, unknown>>(head: T): T {
    propagation.inject(context.active(), head, {
        set: (carrier, key, value) => { (carrier as Record<string, unknown>)[key] = value; },
    });
    return head;
}

// ---- Aggregate entry ------------------------------------------------------

export function startTelemetry(opts: TelemetryOptions = {}): void {
    startTracing(opts);
    startMetrics(opts);
}

export async function stopTelemetry(): Promise<void> {
    await stopMetrics();
    await stopTracing();
}
