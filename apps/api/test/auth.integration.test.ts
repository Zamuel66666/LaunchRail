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

    const successful = await server.inject({
      cookies: { launchrail_session: "session-token" },
      method: "GET",
      url: `/v1/organizations/${organizationId}/deployments/${deploymentId}/health-checks`,
    });
    expect(successful.statusCode).toBe(200);
    expect(successful.json()).toMatchObject({ checks: [{ outcome: "passed", statusCode: 204 }] });
  });

  it("allows deployment control members to promote idempotently", async () => {
    const organizationId = "11111111-1111-4111-8111-111111111111";
    const deploymentId = "22222222-2222-4222-8222-222222222222";
    const identityStore: IdentityStore = {
      ...rejectingIdentityStore,
      async resolveSession() {
        return {
          displayName: "Developer",
          email: "developer@example.test",
          memberships: [
            {
              organizationId,
              organizationName: "Org",
              organizationSlug: "org",
              permissions: ["organization:read", "deployment:control"],
              role: "developer",
            },
          ],
          userId: "33333333-3333-4333-8333-333333333333",
        };
      },
    };
    const transitionStore = {
      async promote(command: {
        deploymentId: string;
        organizationId: string;
        actorUserId?: string;
        idempotencyKey: string;
      }) {
        return {
          deploymentId: command.deploymentId,
          eventSequence: 4,
          from: "health_checking" as const,
          idempotentReplay: false,
          to: "active" as const,
          version: 5,
        };
      },
      async transition(command: {
        deploymentId: string;
        organizationId: string;
        actorUserId?: string;
        idempotencyKey: string;
        to: "cancelling";
      }) {
        return {
          deploymentId: command.deploymentId,
          eventSequence: 2,
          from: "deploying" as const,
          idempotentReplay: false,
          to: command.to,
          version: 3,
        };
      },
    } as unknown as import("@launchrail/application").DeploymentTransitionStore;
    const server = buildServer({ identityStore, transitionStore });
    servers.push(server);
    const response = await server.inject({
      cookies: { launchrail_session: "session-token" },
      headers: { origin: "http://localhost:3000" },
      method: "POST",
      payload: {},
      url: `/v1/organizations/${organizationId}/deployments/${deploymentId}/promote`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ deployment: { to: "active" } });
    const cancelled = await server.inject({
      cookies: { launchrail_session: "session-token" },
      headers: { origin: "http://localhost:3000" },
      method: "POST",
      payload: {},
      url: `/v1/organizations/${organizationId}/deployments/${deploymentId}/cancel`,
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({ deployment: { to: "cancelling" } });
  });
});
