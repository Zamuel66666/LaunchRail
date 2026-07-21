import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  closeWorkerHealthServer,
  createWorkerHealthServer,
  listenForWorkerHealth,
} from "../src/health-server.js";

const servers: ReturnType<typeof createWorkerHealthServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeWorkerHealthServer));
});

describe("worker health server", () => {
  it("serves health over a real local HTTP socket", async () => {
    const server = createWorkerHealthServer({
      now: () => new Date("2026-07-21T10:00:00.000Z"),
      version: "test-version",
    });
    servers.push(server);
    await listenForWorkerHealth(server, "127.0.0.1", 0);
    const address = server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${address.port}/health`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      service: "worker",
      status: "ok",
      timestamp: "2026-07-21T10:00:00.000Z",
      version: "test-version",
    });
  });

  it("returns a structured 404 for unknown paths", async () => {
    const server = createWorkerHealthServer();
    servers.push(server);
    await listenForWorkerHealth(server, "127.0.0.1", 0);
    const address = server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${address.port}/missing`);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });
});
