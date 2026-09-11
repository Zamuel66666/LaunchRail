import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import type { ImageBuilder, RepositoryCheckout, RepositoryProvider } from "@launchrail/application";
import { loadWorkerConfig } from "@launchrail/config";
import { createDatabaseClient, PostgresDeploymentJobStore, schema } from "@launchrail/database";
import { Queue } from "bullmq";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
    await client.db.execute(sql`truncate table organizations, worker_heartbeats cascade`);
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
    const sourceRevision = randomUUID().replaceAll("-", "").padEnd(40, "0");
    await client.db.insert(schema.deployments).values({
      configurationSnapshot: { environment: [] },
      id: deploymentId,
      organizationId,
      projectId,
      sourceRevision,
      sourceSnapshot: {
        contractVersion: 1,
        dockerfilePath: "Dockerfile",
        repositoryName: "queue-recovery",
        repositoryOwner: "launchrail-test",
        repositoryProvider: "github",
        requestedRevision: "main",
      },
    });
    return { deploymentId, organizationId, sourceRevision };
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
      expectedKind: "deployment.claim",
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
      WORKER_BUILD_TIMEOUT_MS: "400",
      WORKER_BUILD_ROOT: `/tmp/launchrail-build-${suffix}`,
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
      WORKER_SOURCE_CLONE_TIMEOUT_MS: "400",
      WORKER_SOURCE_RESOLVE_TIMEOUT_MS: "100",
      WORKER_SOURCE_ROOT: `/tmp/launchrail-source-${suffix}`,
    });
    queueLocations.push({
      prefix: config.WORKER_QUEUE_PREFIX,
      queueName: config.WORKER_QUEUE_NAME,
    });
    const resolveRevision = vi.fn<RepositoryProvider["resolveRevision"]>(async (command) => ({
      canonicalRepositoryUrl: "https://github.com/launchrail-test/queue-recovery",
      commitSha: seeded.sourceRevision,
      entries: [],
      owner: "launchrail-test",
      provider: "github",
      repository: "queue-recovery",
      requestedRevision: command.revision,
      treeSha: "e".repeat(40),
    }));
    const prepare = vi.fn<RepositoryCheckout["prepare"]>(async (command) => ({
      adopted: false,
      checkoutKey: command.checkoutKey,
      commitSha: seeded.sourceRevision,
      contextSha256: "c".repeat(64),
      directory: `/fixture/${command.checkoutKey}`,
      dockerfile: {
        relativePath: command.dockerfilePath,
        resolvedRelativePath: "container/Dockerfile",
        sha256: "d".repeat(64),
        size: 13,
      },
      fileCount: 1,
      totalBytes: 13,
      treeSha: "e".repeat(40),
    }));
    const build = vi.fn<ImageBuilder["build"]>(async (_command, sink) => {
      await sink.write([{ stream: "stdout", content: "Fixture image built\n" }]);
      return {
        adopted: false,
        cacheHitCount: 0,
        cacheMissCount: 1,
        imageDigest: `sha256:${"a".repeat(64)}`,
        imageId: `sha256:${"b".repeat(64)}`,
        imageReference: "launchrail/fixture:build",
        platform: "linux/amd64",
        sizeBytes: 1024,
      };
    });
    const components = createDeploymentWorkerComponents({
      imageBuilder: { build, remove: async () => undefined },
      config,
      database: client.db,
      logger,
      repositoryCheckout: {
        prepare,
        remove: async () => undefined,
      },
      repositoryProvider: { resolveRevision },
      version: "test-version",
      workerId: "worker-after-crash",
    });
    runtimes.push(components.runtime);

    // Redis has never seen this job. Startup reconciliation must rebuild the wake-up from PG.
    await components.runtime.start();
    await waitFor(async () => {
      const deployment = await client.db.query.deployments.findFirst({
        where: (deployments, { eq }) => eq(deployments.id, seeded.deploymentId),
      });
      return deployment?.state === "deploying";
    });

    const completedJobs = await client.db.query.deploymentJobs.findMany({
      where: (jobs, { eq }) => eq(jobs.deploymentId, seeded.deploymentId),
    });
    const sourceJob = completedJobs.find(({ kind }) => kind === "deployment.prepare_source");
    const buildJob = completedJobs.find(({ kind }) => kind === "deployment.build");
    if (buildJob === undefined) {
      throw new Error("Expected a durable build job");
    }
    if (sourceJob === undefined) {
      throw new Error("Expected a durable source preparation job");
    }

    // Fresh duplicate deliveries after all three effects must remain harmless and removable.
    await components.publisher.enqueue({
      contractVersion: 1,
      kind: "deployment.build",
      workItemId: buildJob.id,
    });
    await components.publisher.enqueue({
      contractVersion: 1,
      kind: "deployment.claim",
      workItemId,
    });
    await components.publisher.enqueue({
      contractVersion: 1,
      kind: "deployment.prepare_source",
      workItemId: sourceJob.id,
    });
    await waitFor(async () => (await components.publisher.getState(workItemId)) === "absent");
    await waitFor(
      async () =>
        (await components.publisher.getState(buildJob.id, "deployment.build")) === "absent",
    );
    await waitFor(
      async () =>
        (await components.publisher.getState(sourceJob.id, "deployment.prepare_source")) ===
        "absent",
    );
    await components.runtime.stop();

    const jobs = await client.db.query.deploymentJobs.findMany({
      where: (jobs, { eq }) => eq(jobs.deploymentId, seeded.deploymentId),
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
    const preparedSources = await client.db.query.deploymentSourcePreparations.findMany({
      where: (sources, { eq }) => eq(sources.deploymentId, seeded.deploymentId),
    });
    const artifacts = await client.db.query.deploymentBuildArtifacts.findMany({
      where: (images, { eq }) => eq(images.deploymentId, seeded.deploymentId),
    });
    const logs = await client.db.query.buildLogs.findMany({
      where: (logs, { eq }) => eq(logs.deploymentId, seeded.deploymentId),
    });
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({ imageId: `sha256:${"b".repeat(64)}` });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ content: "Fixture image built\n", stream: "stdout" });

    expect(jobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attemptCount: 2,
          id: workItemId,
          kind: "deployment.claim",
          status: "completed",
        }),
        expect.objectContaining({
          attemptCount: 1,
          id: sourceJob.id,
          kind: "deployment.prepare_source",
          status: "completed",
        }),
      ]),
    );
    expect(jobs).toHaveLength(3);
    expect(jobs.find(({ kind }) => kind === "deployment.build")).toMatchObject({
      status: "completed",
      attemptCount: 1,
    });
    expect(deployment).toMatchObject({ attempt: 4, eventSequence: 3, state: "deploying" });
    expect(preparedSources).toEqual([
      expect.objectContaining({
        checkoutId: seeded.deploymentId,
        dockerfilePath: "Dockerfile",
        dockerfileResolvedPath: "container/Dockerfile",
        resolvedRevision: seeded.sourceRevision,
        treeRevision: "e".repeat(40),
      }),
    ]);
    expect(events).toHaveLength(3);
    expect(commands).toHaveLength(3);
    expect(audits).toHaveLength(3);
    expect(build).toHaveBeenCalledOnce();
    expect(resolveRevision).toHaveBeenCalledOnce();
    expect(resolveRevision.mock.calls[0]?.[0]).toMatchObject({
      repository: { owner: "launchrail-test", repository: "queue-recovery" },
      revision: seeded.sourceRevision,
    });
    expect(prepare).toHaveBeenCalledOnce();
    expect(heartbeats).toHaveLength(1);
    expect(heartbeats[0]).toMatchObject({ activeJobCount: 0, status: "stopped" });
  });
});
