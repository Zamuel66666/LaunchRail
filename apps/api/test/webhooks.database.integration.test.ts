import { createHmac, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import type { CreateDeploymentCommand } from "@launchrail/application";
import {
  AesGcmSecretCipher,
  createDatabaseClient,
  PostgresDeploymentCreationStore,
  PostgresDeploymentJobStore,
  PostgresIdentityStore,
  PostgresProjectManagementStore,
  PostgresWebhookDeliveryStore,
  schema,
} from "@launchrail/database";
import { BullMqDeploymentQueuePublisher } from "@launchrail/queue";
import { Queue } from "bullmq";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildServer } from "../src/server.js";
import { createGitHubWebhookDeploymentTrigger } from "../src/webhook-trigger.js";

const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const suite = databaseUrl && redisUrl ? describe : describe.skip;
const origin = "http://localhost:3000";
const secret = "synthetic-webhook-signing-key";

suite("GitHub delivery persistence and Redis wake-ups", () => {
  if (!databaseUrl || !redisUrl) return;
  const client = createDatabaseClient(databaseUrl);
  const identityStore = new PostgresIdentityStore(client.db);
  const projectStore = new PostgresProjectManagementStore(
    client.db,
    new AesGcmSecretCipher(new Map([[1, new Uint8Array(32).fill(0x42)]]), 1),
  );
  const creation = new PostgresDeploymentCreationStore(client.db);
  const jobs = new PostgresDeploymentJobStore(client.db);
  const deliveries = new PostgresWebhookDeliveryStore(client.db);
  let server: FastifyInstance;
  let publisher: BullMqDeploymentQueuePublisher;
  let prefix: string;
  let organizationId: string;
  let cookie: string;
  let projectId: string;
  let failProject: string | undefined;
  let dispatchUnavailable = false;
  let deferred = 0;

  beforeAll(async () => {
    await migrate(client.db, {
      migrationsFolder: fileURLToPath(
        new URL("../../../packages/database/drizzle", import.meta.url),
      ),
    });
  });
  beforeEach(async () => {
    await client.db.execute(sql`truncate table users, organizations cascade`);
    const principal = await identityStore.bootstrapOwner(
      {
        displayName: "Webhook acceptance owner",
        email: "webhook-owner@launchrail.test",
        password: "Synthetic webhook acceptance password",
        organizationName: "Webhook acceptance",
        organizationSlug: "webhook-acceptance",
      },
      new Date(),
    );
    organizationId = principal.memberships[0]!.organizationId;
    prefix = `webhook_${randomUUID().replaceAll("-", "")}`;
    publisher = new BullMqDeploymentQueuePublisher({ prefix, queueName: "acceptance", redisUrl });
    failProject = undefined;
    dispatchUnavailable = false;
    deferred = 0;
    const trigger = createGitHubWebhookDeploymentTrigger({
      deploymentCreationStore: {
        createDeployment: async (command: CreateDeploymentCommand) => {
          if (command.projectId === failProject) {
            failProject = undefined;
            throw new Error("CANARY_webhook_processing_exception");
          }
          return creation.createDeployment(command);
        },
      },
      deploymentJobStore: jobs,
      maxAttempts: 3,
      projectStore,
      publisher: {
        enqueue: async (job, headers) => {
          if (dispatchUnavailable) throw new Error("CANARY_redis_dispatch_exception");
          return publisher.enqueue(job, headers);
        },
      },
      onDispatchFailure: () => {
        deferred++;
      },
    });
    server = buildServer({
      version: "test",
      identityStore,
      projectStore,
      deploymentStore: jobs,
      webhookStore: deliveries,
      webhookTrigger: trigger,
      webhookSecret: secret,
      webhookOrganizationId: organizationId,
      webOrigin: origin,
    });
    const signedIn = await server.inject({
      method: "POST",
      url: "/v1/auth/sign-in",
      headers: { origin },
      payload: {
        email: "webhook-owner@launchrail.test",
        password: "Synthetic webhook acceptance password",
      },
    });
    expect(signedIn.statusCode).toBe(200);
    cookie = String(signedIn.headers["set-cookie"]).split(";", 1)[0]!;
    projectId = await createProject("Initial matching app");
  });
  afterEach(async () => {
    await server.close();
    await publisher.close();
    const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
    const queue = new Queue("acceptance", { prefix, connection });
    try {
      await queue.obliterate({ force: true });
    } finally {
      await queue.close();
      await connection.quit();
    }
  });
  afterAll(async () => {
    await client.close();
  });

  async function createProject(name: string) {
    const response = await server.inject({
      method: "POST",
      url: `/v1/organizations/${organizationId}/projects`,
      headers: { origin, cookie },
      payload: {
        name,
        repositoryUrl: "https://github.com/octo/app",
        defaultBranch: "main",
        dockerfilePath: "Dockerfile",
        healthCheckPath: "/health",
        healthCheckPort: 3000,
        runtimeConfig: {
          cpuMillicores: 500,
          memoryMegabytes: 512,
          processLimit: 64,
          readOnlyRootFilesystem: true,
        },
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json().project.id as string;
  }
  async function push(
    deliveryId = randomUUID(),
    options: { branch?: string; event?: string; valid?: boolean; payload?: unknown } = {},
  ) {
    const payload = JSON.stringify(
      options.payload ?? {
        after: "a".repeat(40),
        ref: `refs/heads/${options.branch ?? "main"}`,
        repository: { name: "app", owner: { login: "octo" } },
        description: "Raw bytes: café 🚆",
      },
      null,
      2,
    );
    return server.inject({
      method: "POST",
      url: "/v1/webhooks/github",
      payload,
      headers: {
        "content-type": "application/json",
        "x-github-delivery": deliveryId,
        "x-github-event": options.event ?? "push",
        "x-hub-signature-256":
          options.valid === false
            ? `sha256=${"0".repeat(64)}`
            : `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`,
      },
    });
  }

  it("deduplicates verified deliveries into one atomic intent and one real Redis wake-up", async () => {
    const deliveryId = randomUUID();
    expect((await push(deliveryId)).statusCode).toBe(202);
    expect((await push(deliveryId)).statusCode).toBe(200);
    const rows = await client.db.select().from(schema.deployments);
    const work = await client.db.select().from(schema.deploymentJobs);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ projectId, eventSequence: 1, state: "queued" });
    expect(work).toHaveLength(1);
    expect(work[0]).toMatchObject({ maxAttempts: 3, status: "pending" });
    expect(await publisher.getState(work[0]!.id)).toBe("waiting");
    expect(await client.db.select().from(schema.webhookDeploymentTriggers)).toHaveLength(1);
  });

  it("matches provider owner and repository casing to the canonical project URL", async () => {
    const response = await push(randomUUID(), {
      payload: {
        after: "a".repeat(40),
        ref: "refs/heads/main",
        repository: { name: "App", owner: { login: "Octo" } },
      },
    });
    expect(response.statusCode).toBe(202);
    const rows = await client.db.select().from(schema.deployments);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.projectId).toBe(projectId);
    const [job] = await client.db.select().from(schema.deploymentJobs);
    expect(await publisher.getState(job!.id)).toBe("waiting");
  });

  it("rejects invalid signatures, unsupported events and invalid or oversized payloads without intents", async () => {
    expect((await push(randomUUID(), { valid: false })).statusCode).toBe(401);
    expect((await push(randomUUID(), { event: "issues" })).statusCode).toBe(400);
    expect((await push(randomUUID(), { payload: { after: "not-a-revision" } })).statusCode).toBe(
      400,
    );
    expect((await push(randomUUID(), { payload: { filler: "x".repeat(131072) } })).statusCode).toBe(
      413,
    );
    expect(await client.db.select().from(schema.deployments)).toHaveLength(0);
    const records = await client.db.select().from(schema.webhookDeliveries);
    expect(records).toHaveLength(3);
    expect(records.some((row) => row.verificationState === "rejected")).toBe(true);
  });

  it("accepts a verified redelivery after a rejected receipt without losing its audit history", async () => {
    const deliveryId = randomUUID();
    expect((await push(deliveryId, { valid: false })).statusCode).toBe(401);
    const responses = await Promise.all([push(deliveryId), push(deliveryId)]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 202]);
    expect(await client.db.select().from(schema.deployments)).toHaveLength(1);
    const [receipt] = await client.db.select().from(schema.webhookDeliveries);
    expect(receipt).toMatchObject({
      verificationState: "verified",
      processingState: "processed",
      attemptCount: 2,
    });
    const audit = await client.db.select().from(schema.auditEvents);
    expect(audit.find((row) => row.action === "webhook.verification_recovered")).toMatchObject({
      targetId: receipt!.id,
      metadata: expect.objectContaining({
        previousVerificationState: "rejected",
        previousProcessingError: "invalid_signature",
      }),
    });
    expect((await push(deliveryId, { valid: false })).statusCode).toBe(401);
    expect(await client.db.select().from(schema.deployments)).toHaveLength(1);
    // A rejected request may finish marking after a concurrent signed recovery.
    expect(
      await deliveries.mark({
        deliveryId,
        organizationId,
        processingError: "invalid_signature",
        processingState: "failed",
      }),
    ).toMatchObject({ verificationState: "verified", processingState: "processed" });
  });

  it("retries partial processing without duplicating an already accepted project intent", async () => {
    failProject = projectId;
    await createProject("Newer accepted app");
    const deliveryId = randomUUID();
    const failed = await push(deliveryId);
    expect(failed.statusCode).toBe(503);
    expect(failed.body).not.toContain("CANARY_");
    expect(await client.db.select().from(schema.deployments)).toHaveLength(1);
    const retryPath = `/v1/organizations/${organizationId}/webhook-deliveries/${deliveryId}/retry`;
    expect(
      (await server.inject({ method: "POST", url: retryPath, headers: { origin } })).statusCode,
    ).toBe(401);
    const [credential] = await client.db.select().from(schema.passwordCredentials).limit(1);
    const [viewer] = await client.db
      .insert(schema.users)
      .values({ email: "webhook-viewer@launchrail.test", displayName: "Webhook viewer" })
      .returning();
    await client.db
      .insert(schema.passwordCredentials)
      .values({ userId: viewer!.id, passwordHash: credential!.passwordHash });
    await client.db
      .insert(schema.memberships)
      .values({ userId: viewer!.id, organizationId, role: "viewer" });
    const viewerSession = await server.inject({
      method: "POST",
      url: "/v1/auth/sign-in",
      headers: { origin },
      payload: {
        email: "webhook-viewer@launchrail.test",
        password: "Synthetic webhook acceptance password",
      },
    });
    expect(viewerSession.statusCode).toBe(200);
    const viewerCookie = String(viewerSession.headers["set-cookie"]).split(";", 1)[0]!;
    expect(
      (
        await server.inject({
          method: "POST",
          url: retryPath,
          headers: { origin, cookie: viewerCookie },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await server.inject({
          method: "POST",
          url: `/v1/organizations/${randomUUID()}/webhook-deliveries/${deliveryId}/retry`,
          headers: { origin, cookie },
        })
      ).statusCode,
    ).toBe(404);
    const retried = await server.inject({
      method: "POST",
      headers: { origin, cookie },
      url: retryPath,
    });
    expect(retried.statusCode).toBe(200);
    expect(retried.json().delivery).toMatchObject({
      processingState: "processed",
      attemptCount: 2,
    });
    expect(await client.db.select().from(schema.deployments)).toHaveLength(2);
    expect(await client.db.select().from(schema.webhookDeploymentTriggers)).toHaveLength(2);
    const work = await client.db.select().from(schema.deploymentJobs);
    expect(work).toHaveLength(2);
    for (const job of work) expect(await publisher.getState(job.id)).toBe("waiting");
    expect((await push(deliveryId)).statusCode).toBe(200);
    expect(await client.db.select().from(schema.deployments)).toHaveLength(2);
  });

  it("filters branches and retains authoritative work when Redis dispatch is unavailable", async () => {
    expect((await push(randomUUID(), { branch: "other" })).statusCode).toBe(202);
    expect(await client.db.select().from(schema.deployments)).toHaveLength(0);
    dispatchUnavailable = true;
    const result = await push();
    expect(result.statusCode).toBe(202);
    expect(result.body).not.toContain("CANARY_");
    expect(deferred).toBe(1);
    const work = await client.db.select().from(schema.deploymentJobs);
    expect(work).toHaveLength(1);
    expect(await publisher.getState(work[0]!.id)).toBe("absent");
    expect(await jobs.listDispatchable({ limit: 10 })).toHaveLength(1);
  });
});
