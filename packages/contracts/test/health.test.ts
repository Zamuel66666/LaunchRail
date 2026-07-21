import { describe, expect, it } from "vitest";

import { createHealthResponse, launchRailServices } from "../src/index.js";

describe("createHealthResponse", () => {
  it("creates a stable service health contract", () => {
    const response = createHealthResponse({
      now: () => new Date("2026-07-21T08:00:00.000Z"),
      service: "api",
      version: "0.1.0",
    });

    expect(response).toEqual({
      service: "api",
      status: "ok",
      timestamp: "2026-07-21T08:00:00.000Z",
      version: "0.1.0",
    });
    expect(launchRailServices).toEqual(["api", "web", "worker"]);
  });
});
