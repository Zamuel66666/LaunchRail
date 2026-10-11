import {
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
  type Context,
  type Span,
  type SpanOptions,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";

export interface TraceHeaders {
  readonly traceparent?: string;
  readonly tracestate?: string;
}

export interface RequestTrace {
  readonly context: Context;
  readonly span: Span;
}

export interface TracingRuntime {
  shutdown(): Promise<void>;
}

interface BullMqSpan {
  end(): void;
  recordException(error: unknown): void;
  setAttributes(attributes: Readonly<Record<string, unknown>>): void;
  setSpanOnContext(traceContext: unknown): unknown;
}

export interface BullMqTelemetryBridge {
  readonly contextManager: {
    active(): unknown;
    fromMetadata(activeContext: unknown, metadata: string): unknown;
    getMetadata(traceContext: unknown): string;
    with<T>(traceContext: unknown, operation: () => T): T;
  };
  readonly tracer: {
    startSpan(
      name: string,
      options: { readonly kind: number },
      parentContext?: unknown,
    ): BullMqSpan;
  };
}

function normalizedTraceEndpoint(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new RangeError("OTLP endpoint must be a valid HTTP(S) URL");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new RangeError(
      "OTLP endpoint must use HTTP(S) without embedded credentials or query data",
    );
  }
  const path = url.pathname.replace(/\/+$/u, "");
  if (!path.endsWith("/v1/traces")) url.pathname = `${path}/v1/traces`;
  return url.toString();
}

export function initializeTracing(options: {
  readonly endpoint?: string;
  readonly serviceName: "launchrail-api" | "launchrail-worker";
  readonly version: string;
}): TracingRuntime {
  const contextManager = new AsyncLocalStorageContextManager().enable();
  context.setGlobalContextManager(contextManager);
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  const spanProcessors =
    options.endpoint === undefined
      ? []
      : [
          new BatchSpanProcessor(
            new OTLPTraceExporter({ url: normalizedTraceEndpoint(options.endpoint) }),
            {
              exportTimeoutMillis: 5_000,
              maxExportBatchSize: 256,
              maxQueueSize: 1_024,
              scheduledDelayMillis: 2_000,
            },
          ),
        ];
  const provider = new TracerProvider({
    resource: resourceFromAttributes({
      "service.name": options.serviceName,
      "service.version": options.version,
    }),
    spanProcessors,
  });
  trace.setGlobalTracerProvider(provider);
  let shutdownPromise: Promise<void> | undefined;
  return {
    shutdown(): Promise<void> {
      shutdownPromise ??= provider.shutdown().finally(() => contextManager.disable());
      return shutdownPromise;
    },
  };
}

export function startHttpServerTrace(
  method: string,
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
): RequestTrace {
  const carrier: TraceHeaders = {
    ...(typeof headers["traceparent"] === "string" ? { traceparent: headers["traceparent"] } : {}),
    ...(typeof headers["tracestate"] === "string" ? { tracestate: headers["tracestate"] } : {}),
  };
  const parentContext = propagation.extract(context.active(), carrier);
  const span = trace.getTracer("launchrail-http").startSpan(
    `HTTP ${method}`,
    {
      kind: SpanKind.SERVER,
      attributes: { "http.request.method": method },
    },
    parentContext,
  );
  return { context: trace.setSpan(parentContext, span), span };
}

export function finishHttpServerTrace(
  requestTrace: RequestTrace,
  options: {
    readonly durationMs: number;
    readonly route: string | undefined;
    readonly statusCode: number;
  },
): void {
  requestTrace.span.setAttribute("http.response.status_code", options.statusCode);
  requestTrace.span.setAttribute("http.server.request.duration_ms", options.durationMs);
  if (options.route !== undefined && options.route.startsWith("/"))
    requestTrace.span.setAttribute("http.route", options.route);
  if (options.statusCode >= 500) requestTrace.span.setStatus({ code: SpanStatusCode.ERROR });
  else requestTrace.span.setStatus({ code: SpanStatusCode.OK });
  requestTrace.span.end();
}

export function traceHeadersFromContext(traceContext: Context): TraceHeaders {
  const carrier: Record<string, string> = {};
  propagation.inject(traceContext, carrier);
  return {
    ...(carrier.traceparent === undefined ? {} : { traceparent: carrier.traceparent }),
    ...(carrier.tracestate === undefined ? {} : { tracestate: carrier.tracestate }),
  };
}

export function createBullMqTelemetryBridge(): BullMqTelemetryBridge {
  const tracer = trace.getTracer("launchrail-bullmq");
  return {
    contextManager: {
      active: () => context.active(),
      fromMetadata(activeContext, metadata) {
        if (metadata.length > 2_048) return activeContext;
        try {
          const parsed: unknown = JSON.parse(metadata);
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
            return activeContext;
          const candidate = parsed as Record<string, unknown>;
          const carrier: TraceHeaders = {
            ...(typeof candidate.traceparent === "string" && candidate.traceparent.length <= 128
              ? { traceparent: candidate.traceparent }
              : {}),
            ...(typeof candidate.tracestate === "string" && candidate.tracestate.length <= 512
              ? { tracestate: candidate.tracestate }
              : {}),
          };
          return propagation.extract(activeContext as Context, carrier);
        } catch {
          return activeContext;
        }
      },
      getMetadata(traceContext) {
        const carrier: Record<string, string> = {};
        propagation.inject(traceContext as Context, carrier);
        const bounded: TraceHeaders = {
          ...(carrier.traceparent === undefined ? {} : { traceparent: carrier.traceparent }),
          ...(carrier.tracestate === undefined
            ? {}
            : { tracestate: carrier.tracestate.slice(0, 512) }),
        };
        return JSON.stringify(bounded).slice(0, 2_048);
      },
      with: (traceContext, operation) => context.with(traceContext as Context, operation),
    },
    tracer: {
      startSpan(name, options, parentContext) {
        const spanOptions: SpanOptions = { kind: options.kind as SpanKind };
        const span = tracer.startSpan(name, spanOptions, parentContext as Context | undefined);
        return {
          end: () => span.end(),
          recordException: () => {
            span.setAttribute("error.type", "queue_operation_failed");
            span.setStatus({ code: SpanStatusCode.ERROR });
          },
          setAttributes: (attributes) => {
            const safe: Record<string, string | number | boolean> = {};
            for (const [key, value] of Object.entries(attributes)) {
              if (
                (typeof value === "string" && value.length <= 512) ||
                typeof value === "number" ||
                typeof value === "boolean"
              )
                safe[key] = value as string | number | boolean;
            }
            span.setAttributes(safe);
          },
          setSpanOnContext: (traceContext) => trace.setSpan(traceContext as Context, span),
        };
      },
    },
  };
}

export async function withTraceHeaders<T>(
  headers: TraceHeaders | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  const activeContext =
    headers === undefined ? context.active() : propagation.extract(context.active(), headers);
  return await context.with(activeContext, operation);
}

export async function withTraceSpan<T>(
  name: string,
  attributes: Readonly<Record<string, string | number | boolean>>,
  operation: () => Promise<T>,
): Promise<T> {
  return await trace.getTracer("launchrail").startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await operation();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.setAttribute("error.type", error instanceof Error ? "error" : "unknown");
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}
