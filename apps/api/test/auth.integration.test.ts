import { createHmac } from "node:crypto";
import type {
  DeploymentJobStore,
  DeploymentTransitionStore,
  IdentityStore,
} from "@launchrail/application";
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

describe("metrics endpoint", () => {
  it("renders low-cardinality request counters", async () => {
    const server = buildServer();
    servers.push(server);
    expect((await server.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    const response = await server.inject({ method: "GET", url: "/metrics" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("launchrail_http_requests_total");
    expect(response.body).toContain('method="GET"');
    expect(response.headers["x-request-id"]).toBeTypeOf("string");
  });
});

describe("GitHub webhook ingestion", () => {
  it("rejects invalid signatures and deduplicates verified deliveries", async () => {
    const organizationId = "11111111-1111-4111-8111-111111111111";
    const payload = {
      after: "a".repeat(40),
      ref: "refs/heads/main",
      repository: { name: "app", owner: { login: "octo" } },
    };
    const records: Array<{ deliveryId: string }> = [];
    const triggered: string[] = [];
    const server = buildServer({
      webhookOrganizationId: organizationId,
      webhookSecret: "secret",
      webhookStore: {
        async record(command) {
          const duplicate = records.some((record) => record.deliveryId === command.deliveryId);
          if (!duplicate) records.push({ deliveryId: command.deliveryId });
          return {
            ...command,
            duplicate,
            processingState: "pending" as const,
            receivedAt: new Date("2026-01-01T00:00:00Z"),
          };
        },
      },
      webhookTrigger: {
        async trigger(event) {
          triggered.push(event.push.revision);
        },
      },
    });
    servers.push(server);
    const raw = JSON.stringify(payload);
    const signature = `sha256=${createHmac("sha256", "secret").update(raw).digest("hex")}`;
    const request = {
      headers: {
        "x-github-delivery": "delivery-1",
        "x-github-event": "push",
        "x-hub-signature-256": signature,
      },
      method: "POST" as const,
      payload,
      url: "/v1/webhooks/github",
    };
    expect(
      (
        await server.inject({
          ...request,
          headers: {
            ...request.headers,
            "x-github-delivery": "delivery-invalid",
            "x-hub-signature-256": "sha256=bad",
          },
        })
      ).statusCode,
    ).toBe(401);
    expect((await server.inject(request)).statusCode).toBe(202);
    expect((await server.inject(request)).statusCode).toBe(200);
    expect(triggered).toEqual(["a".repeat(40)]);
    const unsupported = await server.inject({
      ...request,
      headers: {
        ...request.headers,
        "x-github-delivery": "delivery-unsupported",
        "x-github-event": "issues",
      },
    });
    expect(unsupported.statusCode).toBe(400);
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
      async rollback(command: {
        deploymentId: string;
        organizationId: string;
        actorUserId?: string;
        idempotencyKey: string;
      }) {
        return {
          deploymentId: command.deploymentId,
          eventSequence: 6,
          from: "active" as const,
          idempotentReplay: false,
          to: "active" as const,
          version: 7,
        };
      },
      async transition(command: {
        deploymentId: string;
        organizationId: string;
        actorUserId?: string;
        idempotencyKey: string;
        to: "cancelling" | "stopped";
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
      async listEvents() {
        return [
          {
            createdAt: new Date("2026-01-01T00:00:00Z"),
            fromState: "deploying" as const,
            kind: "state_changed",
            metadata: {},
            sequence: 1,
            toState: "health_checking" as const,
          },
        ];
      },
    } as unknown as DeploymentTransitionStore;
    const server = buildServer({
      deploymentCreationStore: {
        async createDeployment(command: { organizationId: string; retryOfDeploymentId?: string }) {
          return {
            deploymentId: "44444444-4444-4444-8444-444444444444",
            organizationId: command.organizationId,
            projectId: "55555555-5555-4555-8555-555555555555",
            sourceRevision: "a".repeat(40),
          };
        },
      },
      identityStore,
      transitionStore,
    });
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
    const retry = await server.inject({
      cookies: { launchrail_session: "session-token" },
      headers: { origin: "http://localhost:3000" },
      method: "POST",
      url: `/v1/organizations/${organizationId}/deployments/${deploymentId}/retry`,
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ deployment: { sourceRevision: "a".repeat(40) } });
    const rollback = await server.inject({
      cookies: { launchrail_session: "session-token" },
      headers: { origin: "http://localhost:3000" },
      method: "POST",
      url: `/v1/organizations/${organizationId}/deployments/${deploymentId}/rollback`,
    });
    expect(rollback.statusCode).toBe(200);
    const stopped = await server.inject({
      cookies: { launchrail_session: "session-token" },
      headers: { origin: "http://localhost:3000" },
      method: "POST",
      url: `/v1/organizations/${organizationId}/deployments/${deploymentId}/stop`,
    });
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json()).toMatchObject({ deployment: { to: "stopped" } });
    const events = await server.inject({
      cookies: { launchrail_session: "session-token" },
      method: "GET",
      url: `/v1/organizations/${organizationId}/deployments/${deploymentId}/events?limit=10`,
    });
    expect(events.statusCode).toBe(200);
    expect(events.json()).toMatchObject({ events: [{ kind: "state_changed", sequence: 1 }] });
    const invalidKey = await server.inject({
      cookies: { launchrail_session: "session-token" },
      headers: { origin: "http://localhost:3000", "idempotency-key": "x".repeat(129) },
      method: "POST",
      payload: {},
      url: `/v1/organizations/${organizationId}/deployments/${deploymentId}/promote`,
    });
    expect(invalidKey.statusCode).toBe(400);
  });
});
