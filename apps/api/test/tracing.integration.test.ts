import { createServer } from "node:http";
import { once } from "node:events";
import { initializeTracing, withTraceSpan } from "@launchrail/observability";
import { expect, it } from "vitest";
import { buildServer } from "../src/server.js";

it("parents asynchronous handler/store spans to the actual HTTP request without header or parameter data", async () => {
  const bodies: string[] = [];
  const collector = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    bodies.push(Buffer.concat(chunks).toString("utf8"));
    response.setHeader("content-type", "application/json");
    response.end("{}");
  });
  collector.listen(0, "127.0.0.1");
  await once(collector, "listening");
  const address = collector.address();
  if (!address || typeof address === "string") throw new Error("Missing collector address");
  const runtime = initializeTracing({
    endpoint: `http://127.0.0.1:${address.port}`,
    serviceName: "launchrail-api",
    version: "test",
  });
  const server = buildServer();
  server.get("/trace/:projectId", async () => {
    await Promise.resolve();
    return withTraceSpan(
      "launchrail.database.acceptance.read",
      { "db.system.name": "postgresql" },
      async () => ({ ok: true }),
    );
  });
  const traceId = "abcdefabcdefabcdefabcdefabcdefab";
  try {
    const response = await server.inject({
      method: "GET",
      url: "/trace/CANARY_private_project",
      headers: {
        traceparent: `00-${traceId}-1234567890abcdef-01`,
        tracestate: "vendor=CANARY_private_tracestate",
        authorization: "CANARY_private_authorization",
      },
    });
    expect(response.statusCode).toBe(200);
    await runtime.shutdown();
    const spans = bodies.flatMap((body) =>
      JSON.parse(body).resourceSpans.flatMap(
        (resource: {
          scopeSpans: {
            spans: { name: string; traceId: string; spanId: string; parentSpanId: string }[];
          }[];
        }) => resource.scopeSpans.flatMap((scope) => scope.spans),
      ),
    );
    const http = spans.find((span) => span.name === "HTTP GET");
    const store = spans.find((span) => span.name === "launchrail.database.acceptance.read");
    expect(http?.traceId).toBe(traceId);
    expect(store?.traceId).toBe(traceId);
    expect(store?.parentSpanId).toBe(http?.spanId);
    expect(bodies.join("\n")).not.toContain("CANARY");
  } finally {
    await server.close();
    await runtime.shutdown();
    collector.closeAllConnections();
    await new Promise<void>((resolve) => collector.close(() => resolve()));
  }
});
