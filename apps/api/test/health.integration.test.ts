import { afterEach, describe, expect, it } from "vitest";

import { buildServer } from "../src/server.js";

const servers: ReturnType<typeof buildServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => server.close()));
});

describe("GET /health", () => {
  it.each([
    { payload: "", contentType: "application/json", status: 400 },
    { payload: "{canary-parser-value", contentType: "application/json", status: 400 },
    { payload: "canary-parser-value", contentType: "application/unsupported", status: 415 },
    {
      payload: JSON.stringify("canary-parser-value" + "x".repeat(131072)),
      contentType: "application/json",
      status: 413,
    },
  ])(
    "preserves parser client-error status $status without echoing the body",
    async ({ payload, contentType, status }) => {
      const server = buildServer({ version: "test" });
      servers.push(server);
      server.post("/parser-fixture", async (request) => request.body);
      const response = await server.inject({
        method: "POST",
        url: "/parser-fixture",
        headers: { "content-type": contentType },
        payload,
      });
      expect(response.statusCode).toBe(status);
      expect(response.json().error.code).toBe("invalid_request");
      expect(response.body).not.toContain("canary-parser-value");
    },
  );
  it("reports the API service contract without external dependencies", async () => {
    const server = buildServer({
      now: () => new Date("2026-07-21T09:00:00.000Z"),
      version: "test-version",
    });
    servers.push(server);

    const response = await server.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.json()).toEqual({
      service: "api",
      status: "ok",
      timestamp: "2026-07-21T09:00:00.000Z",
      version: "test-version",
    });
  });
});
