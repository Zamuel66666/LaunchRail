import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { loadWorkerConfig } from "@launchrail/config";
import { createDatabaseClient, PostgresDeploymentJobStore, schema } from "@launchrail/database";
import { Queue } from "bullmq";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDeploymentWorkerComponents } from "../src/composition.js";
import type { WorkerEventLogger } from "../src/processor.js";
import type { DeploymentWorkerRuntime } from "../src/runtime.js";

const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const describeWithServices =
  databaseUrl === undefined || redisUrl === undefined ? describe.skip : describe;

const logger: WorkerEventLogger = {
  error: () => undefined,
  info: () => undefined,
  warn: () => undefined,
};

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for queue integration state");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describeWithServices("deployment worker restart recovery", () => {
  if (databaseUrl === undefined || redisUrl === undefined) {
    return;
  }

  const client = createDatabaseClient(databaseUrl);
  const queueLocations: Array<Readonly<{ prefix: string; queueName: string }>> = [];
  const runtimes: DeploymentWorkerRuntime[] = [];

  beforeAll(async () => {
    await migrate(client.db, {
      migrationsFolder: fileURLToPath(
        new URL("../../../packages/database/drizzle", import.meta.url),
      ),
    });
  });

  beforeEach(async () => {
    await client.db.delete(schema.workerHeartbeats);
    await client.db.delete(schema.organizations);
  });

  afterEach(async () => {
    await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.stop()));
    await Promise.all(
      queueLocations.splice(0).map(async ({ prefix, queueName }) => {
        const connection = new Redis(redisUrl, {
          maxRetriesPerRequest: 1,
          retryStrategy: (attempt) => (attempt <= 1 ? 50 : null),
        });
        connection.on("error", () => undefined);
        const queue = new Queue(queueName, { connection, prefix });
        queue.on("error", () => undefined);
        try {
          await queue.obliterate({ force: true });
        } finally {
          try {
            await queue.close();
          } finally {
            if (connection.status !== "end") {
              try {
                await connection.quit();
              } catch {
                connection.disconnect(false);
              }
            }
          }
        }
      }),
    );
  });

  afterAll(async () => {
    await client.close();
  });

  async function seedQueuedDeployment() {
    const organizationId = randomUUID();
    const projectId = randomUUID();
    const deploymentId = randomUUID();
    await client.db.insert(schema.organizations).values({
      id: organizationId,
      name: "Queue recovery organization",
      slug: `queue-${organizationId.slice(0, 12)}`,
    });
    await client.db.insert(schema.projects).values({
      healthCheckPort: 3000,
      id: projectId,
      name: "Queue recovery project",
      organizationId,
      repositoryName: "queue-recovery",
      repositoryOwner: "launchrail-test",
      runtimeConfig: {
        cpuMillicores: 500,
        memoryMegabytes: 512,
        processLimit: 128,
        readOnlyRootFilesystem: true,
      },
    });
    await client.db.insert(schema.deployments).values({
      configurationSnapshot: { environment: [] },
      id: deploymentId,
      organizationId,
      projectId,
      sourceRevision: randomUUID().replaceAll("-", "").padEnd(40, "0"),
      sourceSnapshot: { branch: "main" },
    });
    return { deploymentId, organizationId };
  }

  it("reconstructs a missing wake-up after a pre-commit crash without duplicate side effects", async () => {
    const seeded = await seedQueuedDeployment();
    const store = new PostgresDeploymentJobStore(client.db);
    const ensured = await store.ensurePendingClaim({
      availableAt: new Date(0),
      deploymentId: seeded.deploymentId,
      maxAttempts: 3,
      organizationId: seeded.organizationId,
    });
    if (ensured.kind !== "created" && ensured.kind !== "existing") {
      throw new Error("Expected a durable deployment claim job");
    }
    const workItemId = ensured.job.id;

    const firstClaim = await store.claim({
      leaseDurationMs: 100,
      workerId: "worker-before-crash",
      workItemId,
    });
    if (firstClaim.kind !== "claimed") {
      throw new Error("Expected the first worker to claim the work item");
    }
    // Simulate process death after lease acquisition but before the atomic
    // transition-and-completion transaction begins.
    await waitFor(async () => {
      const result = await client.db.execute<{ lease_expired: boolean }>(
        sql`select clock_timestamp() >= ${firstClaim.lease.leaseExpiresAt} as lease_expired`,
      );
      return result.rows[0]?.lease_expired === true;
    });
    await expect(store.recoverExpired({ limit: 10 })).resolves.toEqual([
      { id: workItemId, status: "retry_wait" },
    ]);

    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const config = loadWorkerConfig({
      DATABASE_URL: databaseUrl,
      LOG_LEVEL: "silent",
      NODE_ENV: "test",
      REDIS_URL: redisUrl,
      WORKER_BACKOFF_BASE_MS: "1",
      WORKER_BACKOFF_CAP_MS: "1",
      WORKER_CONCURRENCY: "1",
      WORKER_HEARTBEAT_INTERVAL_MS: "20",
      WORKER_JOB_TIMEOUT_MS: "500",
      WORKER_LEASE_MS: "100",
      WORKER_MAX_ATTEMPTS: "3",
      WORKER_QUEUE_NAME: `deployments_${suffix}`,
      WORKER_QUEUE_PREFIX: `launchrail_${suffix}`,
      WORKER_RECONCILIATION_BATCH_SIZE: "10",
      WORKER_RECONCILIATION_INTERVAL_MS: "25",
      WORKER_SHUTDOWN_GRACE_MS: "500",
    });
    queueLocations.push({
      prefix: config.WORKER_QUEUE_PREFIX,
      queueName: config.WORKER_QUEUE_NAME,
    });
    const components = createDeploymentWorkerComponents({
      config,
      database: client.db,
      logger,
      version: "test-version",
      workerId: "worker-after-crash",
    });
    runtimes.push(components.runtime);

    // Redis has never seen this job. Startup reconciliation must rebuild the wake-up from PG.
    await components.runtime.start();
    await waitFor(async () => {
      const job = await client.db.query.deploymentJobs.findFirst({
        where: (jobs, { eq }) => eq(jobs.id, workItemId),
      });
      return job?.status === "completed";
    });

    // A fresh duplicate delivery after completion must also be harmless and removable.
    await components.publisher.enqueue({
      contractVersion: 1,
      kind: "deployment.claim",
      workItemId,
    });
    await waitFor(async () => (await components.publisher.getState(workItemId)) === "absent");
    await components.runtime.stop();

    const job = await client.db.query.deploymentJobs.findFirst({
      where: (jobs, { eq }) => eq(jobs.id, workItemId),
    });
    const deployment = await client.db.query.deployments.findFirst({
      where: (deployments, { eq }) => eq(deployments.id, seeded.deploymentId),
    });
    const events = await client.db.query.deploymentEvents.findMany({
      where: (events, { eq }) => eq(events.deploymentId, seeded.deploymentId),
    });
    const commands = await client.db.query.deploymentCommands.findMany({
      where: (commands, { eq }) => eq(commands.deploymentId, seeded.deploymentId),
    });
    const audits = await client.db.query.auditEvents.findMany({
      where: (audits, { eq }) => eq(audits.targetId, seeded.deploymentId),
    });
    const heartbeats = await client.db.query.workerHeartbeats.findMany({
      where: (workers, { eq }) => eq(workers.workerId, "worker-after-crash"),
    });

    expect(job).toMatchObject({ attemptCount: 2, status: "completed" });
    expect(deployment).toMatchObject({ attempt: 2, eventSequence: 1, state: "cloning" });
    expect(events).toHaveLength(1);
    expect(commands).toHaveLength(1);
    expect(audits).toHaveLength(1);
    expect(heartbeats).toHaveLength(1);
    expect(heartbeats[0]).toMatchObject({ activeJobCount: 0, status: "stopped" });
  });
});
