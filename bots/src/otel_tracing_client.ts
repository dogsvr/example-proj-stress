// Tracing client for stress bots. Bot-side only: starts spans + injects traceparent into outbound heads.

import {
    context, propagation, trace,
    SpanKind, SpanStatusCode,
    type Span,
} from '@opentelemetry/api';
import { NodeTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';

const TRACER_NAME = 'stress-bots';

let provider: NodeTracerProvider | null = null;

export interface BotTracingOptions {
    serviceName?: string;
    otlpEndpoint?: string;
    resourceAttributes?: Record<string, string>;
}

export function setupBotTracing(opts: BotTracingOptions = {}): void {
    if (provider) return;
    const endpoint = opts.otlpEndpoint
        ?? process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
        ?? 'http://localhost:4318/v1/traces';
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
    provider = new NodeTracerProvider({
        resource: resourceFromAttributes({
            'service.name': opts.serviceName ?? 'stress-bots',
            ...(opts.resourceAttributes ?? {}),
        }),
        spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: endpoint }))],
    });
    trace.setGlobalTracerProvider(provider);
}

export async function shutdownBotTracing(): Promise<void> {
    await provider?.shutdown();
    provider = null;
}

/** Run fn under a fresh client span; records exception on throw. */
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

/** Inject W3C trace-context into a tsrpc Head-shaped object. Mutates and returns head. */
export function injectTraceHead<T extends Record<string, unknown>>(head: T): T {
    propagation.inject(context.active(), head, {
        set: (carrier, key, value) => { (carrier as Record<string, unknown>)[key] = value; },
    });
    return head;
}
