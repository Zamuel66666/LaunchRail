import { afterEach, describe, expect, it } from "vitest";

import { buildServer } from "../src/server.js";

const servers: ReturnType<typeof buildServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => server.close()));
});

describe("GET /health", () => {
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
