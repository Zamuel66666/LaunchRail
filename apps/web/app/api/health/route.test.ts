import { describe, expect, it } from "vitest";

import { GET } from "./route";

describe("GET /api/health", () => {
  it("returns the shared web health contract", async () => {
    const response = GET();
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ service: "web", status: "ok", version: "0.1.0" });
    expect(body.timestamp).toEqual(expect.any(String));
  });
});
