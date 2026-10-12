import { createServer, type Server } from "node:http";
import { once } from "node:events";

import { context, propagation, trace } from "@opentelemetry/api";
import { afterEach, describe, expect, it } from "vitest";

import {
  createBullMqTelemetryBridge,
  finishHttpServerTrace,
  initializeTracing,
  startHttpServerTrace,
  traceHeadersFromContext,
  activeTraceLogFields,
  withTraceSpan,
  type TracingRuntime,
} from "../src/tracing.js";

describe("W3C tracing and the real OTLP export boundary", () => {
  let runtime: TracingRuntime | undefined;
  let server: Server | undefined;

  afterEach(async () => {
    await runtime?.shutdown().catch(() => undefined);
    runtime = undefined;
    context.disable();
    propagation.disable();
    trace.disable();
    if (server !== undefined) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  it("exports related HTTP, producer, consumer and database spans without arbitrary queue data", async () => {
    const payloads: unknown[] = [];
    const paths: string[] = [];
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      paths.push(request.url ?? "");
      payloads.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      response.setHeader("content-type", "application/json");
      response.end("{}");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing collector port");
    runtime = initializeTracing({
      endpoint: `http://127.0.0.1:${address.port}`,
      serviceName: "launchrail-api",
      version: "test",
    });
    const canary = "private-canary-password-organization-id";
    const traceId = "1234567890abcdef1234567890abcdef";
    const request = startHttpServerTrace("POST", {
      traceparent: `00-${traceId}-1234567890abcdef-01`,
      tracestate: `vendor=${canary}`,
      authorization: canary,
    });
    const bridge = createBullMqTelemetryBridge();
    await context.with(request.context, async () => {
      const producer = bridge.tracer.startSpan(`add ${canary}`, { kind: 3 });
      producer.setAttributes({
        "bullmq.job.name": "deployment.start_runtime",
        "bullmq.queue.operation": "add",
        "bullmq.job.id": canary,
        "bullmq.job.options": JSON.stringify({ password: canary }),
        "bullmq.job.failed.reason": canary,
        "bullmq.queue.name": canary,
        "bullmq.job.attempts.made": 1,
      });
      const metadata = bridge.contextManager.getMetadata(
        producer.setSpanOnContext(context.active()),
      );
      expect(metadata).not.toContain(canary);
      const parent = bridge.contextManager.fromMetadata(context.active(), metadata);
      const consumer = bridge.tracer.startSpan(`process ${canary}`, { kind: 4 }, parent);
      await bridge.contextManager.with(consumer.setSpanOnContext(parent), async () => {
        await withTraceSpan(
          "launchrail.database.jobs.claim",
          { "db.system.name": "postgresql" },
          async () => undefined,
        );
      });
      consumer.recordException(new Error(canary));
      consumer.addEvent("job failed", { "bullmq.job.failed.reason": canary });
      consumer.end();
      producer.end();
    });
    finishHttpServerTrace(request, {
      durationMs: 10,
      route: "/projects/:projectId/deployments",
      statusCode: 201,
    });
    expect(traceHeadersFromContext(request.context)).not.toHaveProperty("tracestate");
    await runtime.shutdown();
    expect(paths).toEqual(["/v1/traces"]);
    expect(JSON.stringify(payloads)).not.toContain(canary);
    const report = payloads[0] as {
      resourceSpans: Array<{
        scopeSpans: Array<{
          spans: Array<{ name: string; traceId: string; spanId: string; parentSpanId: string }>;
        }>;
      }>;
    };
    const spans = report.resourceSpans.flatMap((resource) =>
      resource.scopeSpans.flatMap((scope) => scope.spans),
    );
    expect(spans.map((span) => span.name).sort()).toEqual(
      ["HTTP POST", "bullmq.add", "bullmq.process", "launchrail.database.jobs.claim"].sort(),
    );
    expect(new Set(spans.map((span) => span.traceId))).toEqual(new Set([traceId]));
    const producer = spans.find((span) => span.name === "bullmq.add");
    const consumer = spans.find((span) => span.name === "bullmq.process");
    expect(consumer?.parentSpanId).toBe(producer?.spanId);
  });

  it("does not let a failed collector change an application result and shuts down once", async () => {
    runtime = initializeTracing({
      endpoint: "http://127.0.0.1:1",
      serviceName: "launchrail-worker",
      version: "test",
    });
    await expect(
      withTraceSpan("launchrail.worker.process", {}, async () => "completed"),
    ).resolves.toBe("completed");
    const first = runtime.shutdown();
    expect(runtime.shutdown()).toBe(first);
    await first.catch(() => undefined);
  });
  it("bounds the export queue and drops excess telemetry without dropping application work", async () => {
    let exported = 0;
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      exported += body.resourceSpans.reduce(
        (sum: number, resource: { scopeSpans: { spans: unknown[] }[] }) =>
          sum + resource.scopeSpans.reduce((n, scope) => n + scope.spans.length, 0),
        0,
      );
      response.end("{}");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing collector port");
    runtime = initializeTracing({
      endpoint: `http://127.0.0.1:${address.port}`,
      serviceName: "launchrail-worker",
      version: "test",
    });
    let completed = 0;
    for (let index = 0; index < 1500; index++)
      await withTraceSpan("launchrail.acceptance.bounded_export", {}, async () => {
        completed++;
      });
    await runtime.shutdown();
    expect(completed).toBe(1500);
    expect(exported).toBeGreaterThan(0);
    expect(exported).toBeLessThan(1500);
    expect(exported).toBeLessThanOrEqual(1280);
  });
  it("provides only validated active trace and span IDs for structured logs", async () => {
    runtime = initializeTracing({ serviceName: "launchrail-api", version: "test" });
    expect(activeTraceLogFields()).toEqual({});
    await withTraceSpan("launchrail.acceptance.log_context", {}, async () => {
      expect(activeTraceLogFields()).toEqual({
        traceId: expect.stringMatching(/^[0-9a-f]{32}$/u),
        spanId: expect.stringMatching(/^[0-9a-f]{16}$/u),
      });
    });
    expect(activeTraceLogFields()).toEqual({});
  });

  it("rejects unsafe collector URLs before registering global tracing", () => {
    for (const endpoint of [
      "not-a-url",
      "http://example.com",
      "https://user:secret@example.com",
      "https://example.com?secret=value",
    ]) {
      expect(() =>
        initializeTracing({ endpoint, serviceName: "launchrail-api", version: "test" }),
      ).toThrow(RangeError);
    }
  });
});
