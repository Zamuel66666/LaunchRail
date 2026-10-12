import type { FastifyRequest } from "fastify";

import {
  finishHttpServerTrace,
  startHttpServerTrace,
  traceHeadersFromContext,
  withHttpServerTrace,
  type RequestTrace,
  type TraceHeaders,
} from "@launchrail/observability";

const requests = new WeakMap<
  FastifyRequest,
  { readonly startedAt: number; readonly trace: RequestTrace }
>();

export function startRequestTrace(request: FastifyRequest): void {
  requests.set(request, {
    startedAt: performance.now(),
    trace: startHttpServerTrace(request.method, request.headers),
  });
}

export function endRequestTrace(
  request: FastifyRequest,
  statusCode: number,
  route: string | undefined,
): void {
  const state = requests.get(request);
  if (state === undefined) return;
  finishHttpServerTrace(state.trace, {
    durationMs: Math.max(0, performance.now() - state.startedAt),
    route,
    statusCode,
  });
  requests.delete(request);
}

export function getRequestTraceHeaders(request: FastifyRequest): TraceHeaders | undefined {
  const state = requests.get(request);
  return state === undefined ? undefined : traceHeadersFromContext(state.trace.context);
}

export function withRequestTrace<T>(request: FastifyRequest, operation: () => T): T {
  const state = requests.get(request);
  return state === undefined ? operation() : withHttpServerTrace(state.trace, operation);
}
