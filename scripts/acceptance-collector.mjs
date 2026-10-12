import { createServer } from "node:http";

if (process.env.LAUNCHRAIL_ACCEPTANCE_ALLOW_COLLECTION !== "DEDICATED_LOCAL_ACCEPTANCE")
  throw new Error("Collector requires dedicated acceptance acknowledgement");
const canary = process.env.LAUNCHRAIL_ACCEPTANCE_TRACE_CANARY;
if (!canary || canary.length < 16 || canary.length > 1024)
  throw new Error("A synthetic trace canary is required");
const payloads = [];
const forbidden = new Set([canary]);
let receivedBytes = 0;
let rejectedSecrets = 0;
let forcedFailures = 0;
let failNext = 0;
const summary = () => {
  const spans = payloads.flatMap((payload) =>
    payload.resourceSpans.flatMap((resource) =>
      resource.scopeSpans.flatMap((scope) => scope.spans),
    ),
  );
  return {
    payloadCount: payloads.length,
    spanCount: spans.length,
    receivedBytes,
    rejectedSecrets,
    forcedFailures,
    serviceNames: [
      ...new Set(
        payloads.flatMap((payload) =>
          payload.resourceSpans.flatMap((resource) =>
            resource.resource.attributes
              .filter((attribute) => attribute.key === "service.name")
              .map((attribute) => attribute.value.stringValue),
          ),
        ),
      ),
    ],
    spanNames: [...new Set(spans.map((span) => span.name))].sort(),
  };
};
const server = createServer(async (request, response) => {
  response.setHeader("content-type", "application/json");
  try {
    if (request.method === "GET" && request.url === "/status")
      return response.end(JSON.stringify(summary()));
    if (request.method === "GET" && request.url === "/report")
      return response.end(JSON.stringify({ ...summary(), payloads }));
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 2097152) {
        response.writeHead(413).end("{}");
        return;
      }
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    if (request.method === "POST" && request.url === "/control") {
      const control = JSON.parse(raw);
      if (control.forbiddenValues !== undefined) {
        if (
          !Array.isArray(control.forbiddenValues) ||
          control.forbiddenValues.length > 16 ||
          forbidden.size + control.forbiddenValues.length > 64 ||
          control.forbiddenValues.some(
            (value) => typeof value !== "string" || value.length < 8 || value.length > 1024,
          )
        )
          throw new Error("Invalid forbidden-value fixture");
        for (const value of control.forbiddenValues) forbidden.add(value);
      }
      if (control.failNext !== undefined) {
        if (!Number.isInteger(control.failNext) || control.failNext < 0 || control.failNext > 3)
          throw new Error("Invalid failure fixture");
        failNext = control.failNext;
      }
      return response.end("{}");
    }
    if (request.method !== "POST" || request.url !== "/v1/traces")
      return response.writeHead(404).end("{}");
    receivedBytes += size;
    if ([...forbidden].some((value) => raw.includes(value))) {
      rejectedSecrets++;
      return response.writeHead(422).end("{}");
    }
    const payload = JSON.parse(raw);
    if (
      !Array.isArray(payload.resourceSpans) ||
      payload.resourceSpans.some(
        (resource) =>
          !Array.isArray(resource?.resource?.attributes) ||
          resource.resource.attributes.some(
            (attribute) =>
              typeof attribute?.key !== "string" ||
              (attribute.key === "service.name" &&
                typeof attribute?.value?.stringValue !== "string"),
          ) ||
          !Array.isArray(resource.scopeSpans) ||
          resource.scopeSpans.some(
            (scope) =>
              !Array.isArray(scope?.spans) ||
              scope.spans.some((span) => typeof span?.name !== "string"),
          ),
      )
    )
      throw new Error("Invalid OTLP fixture");
    if (failNext > 0) {
      failNext--;
      forcedFailures++;
      return response.writeHead(503).end("{}");
    }
    if (receivedBytes > 16777216) return response.writeHead(413).end("{}");
    payloads.push(payload);
    response.end("{}");
  } catch {
    response.writeHead(400).end("{}");
  }
});
server.requestTimeout = 5000;
server.headersTimeout = 5000;
server.maxConnections = 8;
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  process.stdout.write(JSON.stringify({ collector: `http://127.0.0.1:${address.port}` }) + "\n");
});
process.once("SIGTERM", () => {
  server.closeAllConnections();
  server.close();
});
