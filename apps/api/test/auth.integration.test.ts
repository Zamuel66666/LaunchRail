import type { IdentityStore } from "@launchrail/application";
import { afterEach, describe, expect, it } from "vitest";

import { buildServer } from "../src/server.js";

const servers: ReturnType<typeof buildServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => server.close()));
});

const rejectingIdentityStore: IdentityStore = {
  async bootstrapOwner() {
    throw new Error("not used");
  },
  async getOrganization() {
    throw new Error("not used");
  },
  async listAuditEvents() {
    throw new Error("not used");
  },
  async listMembers() {
    throw new Error("not used");
  },
  async resolveSession() {
    throw new Error("not used");
  },
  async revokeSession() {
    throw new Error("not used");
  },
  async signIn() {
    return null;
  },
  async updateMembershipRole() {
    throw new Error("not used");
  },
};

describe("sign-in request hardening", () => {
  it("applies the configured per-client sign-in limit", async () => {
    const server = buildServer({
      identityStore: rejectingIdentityStore,
      signInRateLimitMax: 2,
      webOrigin: "http://localhost:3000",
    });
    servers.push(server);
    const request = {
      headers: { origin: "http://localhost:3000" },
      method: "POST" as const,
      payload: {
        email: "unknown@launchrail.test",
        password: "not-a-real-password",
      },
      url: "/v1/auth/sign-in",
    };

    expect((await server.inject(request)).statusCode).toBe(401);
    expect((await server.inject(request)).statusCode).toBe(401);
    const limited = await server.inject(request);

    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({
      error: { code: "rate_limited", message: "Too many requests; try again later" },
    });
  });
});
