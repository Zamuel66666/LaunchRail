import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createDatabaseClient,
  PostgresDeploymentCreationStore,
  PostgresDeploymentJobStore,
  schema,
} from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;
const withDatabase = databaseUrl === undefined ? describe.skip : describe;

withDatabase("deployment creation transactions", () => {
  if (databaseUrl === undefined) return;
  const client = createDatabaseClient(databaseUrl);
  const store = new PostgresDeploymentCreationStore(client.db, 7);
  beforeAll(async () => {
    await migrate(client.db, {
      migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
    });
  });
  beforeEach(async () => {
    await client.db.execute(sql`truncate table users, organizations cascade`);
  });
  afterAll(async () => {
    await client.close();
  });

  async function project() {
    const organizationId = randomUUID();
    const projectId = randomUUID();
    await client.db.insert(schema.organizations).values({
      id: organizationId,
      name: "Creation acceptance",
      slug: `creation-${organizationId}`,
    });
    await client.db.insert(schema.projects).values({
      id: projectId,
      organizationId,
      name: "Creation fixture",
      repositoryName: "launchrail",
      repositoryOwner: "zamuel66666",
      dockerfilePath: "examples/apps/healthy/Dockerfile",
      healthCheckPath: "/",
      healthCheckPort: 3000,
      runtimeConfig: {
        cpuMillicores: 500,
        memoryMegabytes: 256,
        processLimit: 64,
        readOnlyRootFilesystem: true,
      },
    });
    return { organizationId, projectId, sourceRevision: "a".repeat(40) };
  }

  it("atomically stores the initial positive-sequence event, immutable snapshot, audit and claim", async () => {
    const input = await project();
    const created = await store.createDeployment(input);
    const [deployment] = await client.db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, created.deploymentId));
    const events = await client.db
      .select()
      .from(schema.deploymentEvents)
      .where(eq(schema.deploymentEvents.deploymentId, created.deploymentId));
    const jobs = await client.db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.deploymentId, created.deploymentId));
    const audits = await client.db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.targetId, created.deploymentId));
    expect(deployment).toMatchObject({
      state: "queued",
      eventSequence: 1,
      configurationSnapshot: {
        healthCheckPath: "/",
        dockerfilePath: "examples/apps/healthy/Dockerfile",
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      sequence: 1,
      fromState: null,
      toState: "queued",
      kind: "deployment_created",
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      kind: "deployment.claim",
      status: "pending",
      maxAttempts: 7,
      organizationId: input.organizationId,
    });
    expect(audits).toHaveLength(1);
  });
  it("retains only validated immutable trace context for reconstructed stage wake-ups", async () => {
    const input = await project();
    const traceParent = "00-abcdefabcdefabcdefabcdefabcdefab-1234567890abcdef-01";
    const created = await store.createDeployment({ ...input, traceParent });
    const jobStore = new PostgresDeploymentJobStore(client.db);
    const jobs = await jobStore.listDispatchable({ limit: 10 });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.traceParent).toBe(traceParent);
    const claimed = await jobStore.claim({
      workItemId: jobs[0]!.id,
      expectedKind: "deployment.claim",
      workerId: "trace-acceptance",
      leaseDurationMs: 60000,
    });
    if (claimed.kind !== "claimed") throw new Error("Expected claim lease");
    await jobStore.completeClaimTransition({
      workItemId: claimed.lease.workItemId,
      leaseToken: claimed.lease.leaseToken,
    });
    expect(await jobStore.listDispatchable({ limit: 10 })).toEqual([
      expect.objectContaining({ kind: "deployment.prepare_source", traceParent }),
    ]);
    await expect(
      client.db
        .update(schema.deployments)
        .set({ traceParent: null })
        .where(eq(schema.deployments.id, created.deploymentId)),
    ).rejects.toThrow();
    await expect(
      store.createDeployment({ ...input, traceParent: "CANARY_secret_context" }),
    ).rejects.toThrow("Invalid deployment trace context");
    await expect(
      store.createDeployment({ ...input, traceParent: `00-${"0".repeat(32)}-1234567890abcdef-01` }),
    ).rejects.toThrow("Invalid deployment trace context");
    expect(await client.db.select().from(schema.deployments)).toHaveLength(1);
  });

  it("coalesces concurrent verified delivery retries into one deployment and claim", async () => {
    const input = await project();
    await client.db.insert(schema.webhookDeliveries).values({
      organizationId: input.organizationId,
      provider: "github",
      deliveryId: "creation-delivery",
      eventName: "push",
      payloadDigest: "a".repeat(64),
      verificationState: "verified",
    });
    const command = {
      ...input,
      maxAttempts: 3,
      sourceEvent: { provider: "github", deliveryId: "creation-delivery" },
    };
    const results = await Promise.all(
      Array.from({ length: 8 }, () => store.createDeployment(command)),
    );
    expect(new Set(results.map((result) => result.deploymentId)).size).toBe(1);
    expect(await client.db.select().from(schema.deployments)).toHaveLength(1);
    const jobs = await client.db.select().from(schema.deploymentJobs);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.maxAttempts).toBe(3);
  });

  it("rolls back all rows when delivery ownership cannot be established", async () => {
    const input = await project();
    await expect(
      store.createDeployment({
        ...input,
        sourceEvent: { provider: "github", deliveryId: "unrecorded-delivery" },
      }),
    ).rejects.toThrow();
    for (const table of [
      schema.deployments,
      schema.deploymentEvents,
      schema.deploymentJobs,
      schema.auditEvents,
    ])
      expect(await client.db.select().from(table)).toHaveLength(0);
  });

  it("conceals foreign and archived projects before creating work", async () => {
    const input = await project();
    await expect(
      store.createDeployment({ ...input, organizationId: randomUUID() }),
    ).rejects.toMatchObject({ name: "DeploymentNotFoundError" });
    await client.db
      .update(schema.projects)
      .set({ archivedAt: new Date() })
      .where(eq(schema.projects.id, input.projectId));
    await expect(store.createDeployment(input)).rejects.toMatchObject({
      name: "DeploymentNotFoundError",
    });
    expect(await client.db.select().from(schema.deployments)).toHaveLength(0);
  });
});
