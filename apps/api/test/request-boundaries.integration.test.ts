import { createHmac } from "node:crypto";
import { request as httpRequest } from "node:http";
import { Writable } from "node:stream";
import { serviceLoggerOptions } from "@launchrail/observability";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

const servers: ReturnType<typeof buildServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("HTTP request boundaries", () => {
  it("does not log actual path, query, headers or request body with automatic logging enabled", async () => {
    let output = "";
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        output += String(chunk);
        callback();
      },
    });
    const server = buildServer({ logger: { ...serviceLoggerOptions("api", "info"), stream } });
    servers.push(server);
    server.post("/private/:recordId", async () => ({ ok: true }));
    const response = await server.inject({
      method: "POST",
      url: "/private/PRIVATE_CANARY?token=PRIVATE_CANARY",
      headers: { "x-private": "PRIVATE_CANARY" },
      payload: { arbitrary: "PRIVATE_CANARY" },
    });
    expect(response.statusCode).toBe(200);
    expect(output).not.toContain("PRIVATE_CANARY");
    expect(output).toContain("/private/:recordId");
    expect(output).toContain("api_request_completed");
  });

  it.each(["/v1/webhooks/github", "/v1/webhooks/github?ignored=PRIVATE_CANARY"])(
    "rejects oversized streamed raw-body capture at %s before recording a delivery",
    async (url) => {
      const server = buildServer();
      servers.push(server);
      let handled = false;
      server.post("/v1/webhooks/github", async () => {
        handled = true;
        return {};
      });
      await server.listen({ port: 0, host: "127.0.0.1" });
      const address = server.server.address();
      if (address === null || typeof address === "string") throw new Error("Missing HTTP address");
      const response = await new Promise<{ status: number | undefined; body: string }>(
        (resolve, reject) => {
          const request = httpRequest(
            {
              host: "127.0.0.1",
              port: address.port,
              path: url,
              method: "POST",
              headers: { "content-type": "application/json", "transfer-encoding": "chunked" },
            },
            (incoming) => {
              let body = "";
              incoming.setEncoding("utf8");
              incoming.on("data", (chunk) => {
                body += chunk;
              });
              incoming.on("end", () => {
                request.destroy();
                resolve({ status: incoming.statusCode, body });
              });
              incoming.on("error", reject);
            },
          );
          request.on("error", reject);
          request.setTimeout(3_000, () => {
            request.destroy();
            reject(new Error("Body limit did not respond before stream completion"));
          });
          // Rejection must happen before EOF, without a Content-Length.
          request.write(Buffer.alloc(131_073, "x"));
        },
      );
      expect(response.status).toBe(413);
      expect(JSON.parse(response.body).error.code).toBe("invalid_request");
      expect(handled).toBe(false);
      expect(response.body).not.toContain("PRIVATE_CANARY");
    },
  );

  it("preserves exact raw bytes for signed JSON including whitespace and Unicode with a query", async () => {
    const server = buildServer();
    servers.push(server);
    const raw = '{ "message": "žluťoučký" }\n';
    let digest = "";
    server.post("/v1/webhooks/github", async (request) => {
      digest = createHmac("sha256", "synthetic-key")
        .update((request as typeof request & { rawBody: Uint8Array }).rawBody)
        .digest("hex");
      return request.body;
    });
    const response = await server.inject({
      method: "POST",
      url: "/v1/webhooks/github?ignored=1",
      headers: { "content-type": "application/json" },
      payload: raw,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ message: "žluťoučký" });
    expect(digest).toBe(createHmac("sha256", "synthetic-key").update(raw).digest("hex"));
  });
});
