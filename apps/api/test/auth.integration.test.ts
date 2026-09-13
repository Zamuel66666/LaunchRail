import type { DeploymentJobStore, IdentityStore } from "@launchrail/application";
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

describe("deployment health history", () => {
  it("requires membership and bounds history limits", async () => {
    const organizationId = "11111111-1111-4111-8111-111111111111";
    const deploymentId = "22222222-2222-4222-8222-222222222222";
    const identityStore: IdentityStore = {
      ...rejectingIdentityStore,
      async resolveSession() {
        return {
          displayName: "Owner",
          email: "owner@example.test",
          memberships: [
            {
              organizationId,
              organizationName: "Org",
              organizationSlug: "org",
              permissions: ["organization:read", "project:read"],
              role: "owner",
            },
          ],
          userId: "33333333-3333-4333-8333-333333333333",
        };
      },
    };
    const deploymentStore = {
      async listHealthChecks() {
        return [
          {
            checkedAt: new Date("2026-01-01T00:00:00Z"),
            durationMs: 4,
            outcome: "passed" as const,
            statusCode: 204,
          },
        ];
      },
    } as unknown as DeploymentJobStore;
    const server = buildServer({ identityStore, deploymentStore });
    servers.push(server);
    const response = await server.inject({
      cookies: { launchrail_session: "session-token" },
      method: "GET",
      url: `/v1/organizations/${organizationId}/deployments/${deploymentId}/health-checks?limit=101`,
    });
    expect(response.statusCode).toBe(400);
  });
});
