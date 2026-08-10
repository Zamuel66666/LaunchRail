import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { eq, inArray, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createDatabaseClient,
  DeploymentPersistenceConflictError,
  PostgresDeploymentJobStore,
  PostgresDeploymentTransitionStore,
  schema,
} from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;
const describeWithDatabase = databaseUrl === undefined ? describe.skip : describe;
const start = new Date("2026-08-10T10:00:00.000Z");

function after(milliseconds: number): Date {
  return new Date(start.getTime() + milliseconds);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function findDatabaseError(
  error: unknown,
): { readonly code: unknown; readonly message: unknown } | undefined {
  let candidate: unknown = error;
  for (
    let depth = 0;
    depth < 4 && candidate !== null && typeof candidate === "object";
    depth += 1
  ) {
    if ("code" in candidate && "message" in candidate) {
      return { code: candidate.code, message: candidate.message };
    }
    candidate = "cause" in candidate ? candidate.cause : undefined;
  }
  return undefined;
}

describeWithDatabase("PostgresDeploymentJobStore", () => {
  if (databaseUrl === undefined) {
    return;
  }

  const client = createDatabaseClient(databaseUrl);
  const store = new PostgresDeploymentJobStore(client.db);
  const transitionStore = new PostgresDeploymentTransitionStore(client.db);

  beforeAll(async () => {
    await migrate(client.db, {
      migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
    });
  });

  beforeEach(async () => {
    await client.db.execute(sql`truncate table users, organizations, worker_heartbeats cascade`);
  });

  afterAll(async () => {
    await client.close();
  });

  async function seedDeployment(
    options: {
      readonly organizationId?: string;
      readonly projectId?: string;
      readonly state?: (typeof schema.deploymentState.enumValues)[number];
    } = {},
  ) {
    const organizationId = options.organizationId ?? randomUUID();
    const projectId = options.projectId ?? randomUUID();
    const deploymentId = randomUUID();
    const repositoryName = `repository-${projectId.slice(0, 8)}`;
    const sourceRevision = randomUUID().replaceAll("-", "").padEnd(40, "0");

    if (options.organizationId === undefined) {
      await client.db.insert(schema.organizations).values({
        id: organizationId,
        name: `Organization ${organizationId.slice(0, 6)}`,
        slug: `jobs-${organizationId.slice(0, 12)}`,
      });
    }
    if (options.projectId === undefined) {
      await client.db.insert(schema.projects).values({
        healthCheckPort: 3_000,
        id: projectId,
        name: `Project ${projectId.slice(0, 6)}`,
        organizationId,
        repositoryName,
        repositoryOwner: "launchrail-test",
        runtimeConfig: {
          cpuMillicores: 500,
          memoryMegabytes: 512,
          processLimit: 128,
          readOnlyRootFilesystem: true,
        },
      });
    }

    await client.db.insert(schema.deployments).values({
      configurationSnapshot: { projectVersion: 1 },
      id: deploymentId,
      organizationId,
      projectId,
      sourceRevision,
      sourceSnapshot: {
        contractVersion: 1,
        dockerfilePath: "Dockerfile",
        repositoryName,
        repositoryOwner: "launchrail-test",
        repositoryProvider: "github",
        requestedRevision: "main",
      },
      state: options.state ?? "queued",
    });
    return { deploymentId, organizationId, projectId, sourceRevision };
  }

  async function ensureClaim(
    deployment: { readonly deploymentId: string; readonly organizationId: string },
    maxAttempts = 3,
    availableAt = new Date(0),
  ) {
    const result = await store.ensurePendingClaim({
      availableAt,
      deploymentId: deployment.deploymentId,
      maxAttempts,
      organizationId: deployment.organizationId,
    });
    if (result.kind !== "created" && result.kind !== "existing") {
      throw new Error(`Expected a deployment job, received ${result.kind}`);
    }
    return result.job;
  }

  async function enterCloning(
    deployment: { readonly deploymentId: string; readonly organizationId: string },
    maxAttempts = 3,
  ) {
    const claimJob = await ensureClaim(deployment, maxAttempts);
    const claimed = await claim(claimJob.id);
    if (claimed.kind !== "claimed") {
      throw new Error(`Expected claim work lease, received ${claimed.kind}`);
    }
    const completed = await store.completeClaimTransition({
      leaseToken: claimed.lease.leaseToken,
      workItemId: claimJob.id,
    });
    if (completed.kind !== "completed") {
      throw new Error(`Expected claim completion, received ${completed.kind}`);
    }
    const sourceJobs = await client.db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.deploymentId, deployment.deploymentId));
    const sourceJob = sourceJobs.find(({ kind }) => kind === "deployment.prepare_source");
    if (sourceJob === undefined) {
      throw new Error("Expected source-preparation work");
    }
    return sourceJob;
  }

  async function databaseNow(): Promise<Date> {
    const clock = await client.db.execute<{ now_milliseconds: number }>(
      sql`select (extract(epoch from clock_timestamp()) * 1000)::double precision as now_milliseconds`,
    );
    const value = clock.rows[0]?.now_milliseconds;
    if (value === undefined) {
      throw new Error("PostgreSQL did not return its clock");
    }
    return new Date(value);
  }

  async function waitForDatabaseTime(target: Date): Promise<void> {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      if ((await databaseNow()).getTime() >= target.getTime()) {
        return;
      }
      await delay(10);
    }
    throw new Error(`PostgreSQL clock did not reach ${target.toISOString()}`);
  }

  async function claim(
    workItemId: string,
    options: {
      readonly expectedKind?: "deployment.claim" | "deployment.prepare_source";
      readonly leaseDurationMs?: number;
      readonly workerId?: string;
    } = {},
  ) {
    return store.claim({
      expectedKind: options.expectedKind ?? "deployment.claim",
      leaseDurationMs: options.leaseDurationMs ?? 30_000,
      workItemId,
      workerId: options.workerId ?? "worker-a",
    });
  }

  async function expireLease(workItemId: string): Promise<void> {
    await client.db
      .update(schema.deploymentJobs)
      .set({
        heartbeatAt: sql`clock_timestamp() - interval '2 seconds'`,
        leaseExpiresAt: sql`clock_timestamp() - interval '1 second'`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(schema.deploymentJobs.id, workItemId));
  }

  async function makeAvailable(workItemId: string): Promise<void> {
    await client.db
      .update(schema.deploymentJobs)
      .set({
        availableAt: sql`clock_timestamp() - interval '1 millisecond'`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(schema.deploymentJobs.id, workItemId));
  }

  it("idempotently ensures scoped claim work and discovers only missing queued deployments", async () => {
    const first = await seedDeployment();
    const second = await seedDeployment({
      organizationId: first.organizationId,
      projectId: first.projectId,
    });
    const building = await seedDeployment({
      organizationId: first.organizationId,
      projectId: first.projectId,
      state: "building",
    });

    await expect(
      store.ensurePendingClaim({
        availableAt: start,
        deploymentId: first.deploymentId,
        maxAttempts: 3,
        organizationId: randomUUID(),
      }),
    ).resolves.toEqual({ kind: "deployment_not_found" });

    const firstEnsure = await store.ensurePendingClaim({
      availableAt: new Date(0),
      deploymentId: first.deploymentId,
      maxAttempts: 3,
      organizationId: first.organizationId,
    });
    const duplicateEnsure = await store.ensurePendingClaim({
      availableAt: after(60_000),
      deploymentId: first.deploymentId,
      maxAttempts: 8,
      organizationId: first.organizationId,
    });
    expect(firstEnsure.kind).toBe("created");
    expect(duplicateEnsure).toMatchObject({
      job: {
        id: firstEnsure.kind === "created" ? firstEnsure.job.id : "unreachable",
        maxAttempts: 3,
      },
      kind: "existing",
    });

    await expect(
      store.ensurePendingClaim({
        availableAt: start,
        deploymentId: building.deploymentId,
        maxAttempts: 3,
        organizationId: building.organizationId,
      }),
    ).resolves.toEqual({ kind: "deployment_ineligible", state: "building" });

    const reconciliationStartedAt = await databaseNow();
    const discovered = await store.ensureMissingClaims({ limit: 20, maxAttempts: 4 });
    const reconciliationFinishedAt = await databaseNow();
    expect(discovered).toHaveLength(1);
    expect(discovered[0]).toMatchObject({
      deploymentId: second.deploymentId,
      maxAttempts: 4,
      status: "pending",
    });
    expect(discovered[0]?.availableAt.getTime()).toBeGreaterThanOrEqual(
      reconciliationStartedAt.getTime(),
    );
    expect(discovered[0]?.availableAt.getTime()).toBeLessThanOrEqual(
      reconciliationFinishedAt.getTime(),
    );
    await expect(store.ensureMissingClaims({ limit: 20, maxAttempts: 4 })).resolves.toEqual([]);

    await expect(store.listDispatchable({ limit: 20 })).resolves.toHaveLength(2);
  });

  it("uses the database clock for scheduled dispatch and lease creation", async () => {
    const deployment = await seedDeployment();
    const databaseTime = await databaseNow();
    const scheduledAt = new Date(databaseTime.getTime() + 60_000);
    const job = await ensureClaim(deployment, 3, scheduledAt);

    await expect(store.listDispatchable({ limit: 10 })).resolves.toEqual([]);
    await expect(claim(job.id)).resolves.toEqual({ availableAt: scheduledAt, kind: "not_due" });

    await makeAvailable(job.id);
    const claimStartedAt = await databaseNow();
    const claimed = await claim(job.id, { leaseDurationMs: 30_000 });
    const claimFinishedAt = await databaseNow();
    if (claimed.kind !== "claimed") {
      throw new Error(`Expected database-due claim, received ${claimed.kind}`);
    }
    const [stored] = await client.db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.id, job.id));
    expect(stored?.heartbeatAt?.getTime()).toBeGreaterThanOrEqual(claimStartedAt.getTime());
    expect(stored?.heartbeatAt?.getTime()).toBeLessThanOrEqual(claimFinishedAt.getTime());
    expect(claimed.lease.leaseExpiresAt.getTime() - (stored?.heartbeatAt?.getTime() ?? 0)).toBe(
      30_000,
    );
    await expect(claim(job.id, { workerId: "clock-skewed-worker" })).resolves.toMatchObject({
      kind: "busy",
    });
  });

  it("serializes a single fresh lease and increments authoritative attempts once", async () => {
    const deployment = await seedDeployment();
    const job = await ensureClaim(deployment);

    const outcomes = await Promise.all([
      claim(job.id, { workerId: "worker-a" }),
      claim(job.id, { workerId: "worker-b" }),
    ]);
    const claimed = outcomes.find((outcome) => outcome.kind === "claimed");
    expect(claimed?.kind).toBe("claimed");
    expect(outcomes.filter((outcome) => outcome.kind === "busy")).toHaveLength(1);

    const [storedJob] = await client.db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.id, job.id));
    const [storedDeployment] = await client.db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, deployment.deploymentId));
    expect(storedJob).toMatchObject({ attemptCount: 1, status: "running" });
    expect(storedDeployment).toMatchObject({ attempt: 1, startedAt: expect.any(Date) });
    const startedAt = storedDeployment?.startedAt;
    expect(startedAt).toBeInstanceOf(Date);

    await expect(claim(job.id, { workerId: "worker-c" })).resolves.toMatchObject({ kind: "busy" });
    const [unchangedDeployment] = await client.db
      .select({ attempt: schema.deployments.attempt, startedAt: schema.deployments.startedAt })
      .from(schema.deployments)
      .where(eq(schema.deployments.id, deployment.deploymentId));
    expect(unchangedDeployment).toEqual({ attempt: 1, startedAt });
  });

  it("extends only a current lease and fences a stale worker after recovery", async () => {
    const deployment = await seedDeployment();
    const job = await ensureClaim(deployment, 3, new Date(0));
    const first = await claim(job.id, { leaseDurationMs: 10_000 });
    if (first.kind !== "claimed") {
      throw new Error(`Expected claim, received ${first.kind}`);
    }

    await expect(
      store.heartbeat({
        leaseDurationMs: 20_000,
        leaseToken: randomUUID(),
        workItemId: job.id,
      }),
    ).resolves.toEqual({ kind: "lease_mismatch" });
    const extendedFirst = await store.heartbeat({
      leaseDurationMs: 20_000,
      leaseToken: first.lease.leaseToken,
      workItemId: job.id,
    });
    expect(extendedFirst.kind).toBe("extended");
    if (extendedFirst.kind !== "extended") {
      throw new Error(`Expected lease extension, received ${extendedFirst.kind}`);
    }
    expect(extendedFirst.leaseExpiresAt.getTime()).toBeGreaterThan(
      first.lease.leaseExpiresAt.getTime(),
    );

    await expireLease(job.id);
    await expect(
      store.heartbeat({
        leaseDurationMs: 20_000,
        leaseToken: first.lease.leaseToken,
        workItemId: job.id,
      }),
    ).resolves.toEqual({ kind: "lease_expired" });
    await expect(
      store.fail({
        leaseToken: first.lease.leaseToken,
        retryDelayMs: 0,
        safeErrorCode: "worker_step_failed",
        safeErrorMessage: "An expired worker cannot revive its lease",
        workItemId: job.id,
      }),
    ).resolves.toEqual({ kind: "lease_expired" });
    await expect(store.recoverExpired({ limit: 10 })).resolves.toEqual([
      { id: job.id, status: "retry_wait" },
    ]);
    const second = await claim(job.id, {
      leaseDurationMs: 10_000,
      workerId: "worker-b",
    });
    if (second.kind !== "claimed") {
      throw new Error(`Expected reclaimed work, received ${second.kind}`);
    }
    expect(second.lease.attemptCount).toBe(2);
    expect(second.lease.leaseToken).not.toBe(first.lease.leaseToken);

    await expect(
      store.heartbeat({
        leaseDurationMs: 20_000,
        leaseToken: first.lease.leaseToken,
        workItemId: job.id,
      }),
    ).resolves.toEqual({ kind: "lease_mismatch" });
    const extendedSecond = await store.heartbeat({
      leaseDurationMs: 20_000,
      leaseToken: second.lease.leaseToken,
      workItemId: job.id,
    });
    expect(extendedSecond.kind).toBe("extended");
    if (extendedSecond.kind !== "extended") {
      throw new Error(`Expected lease extension, received ${extendedSecond.kind}`);
    }
    expect(extendedSecond.leaseExpiresAt.getTime()).toBeGreaterThan(
      second.lease.leaseExpiresAt.getTime(),
    );

    const [storedDeployment] = await client.db
      .select({ attempt: schema.deployments.attempt, startedAt: schema.deployments.startedAt })
      .from(schema.deployments)
      .where(eq(schema.deployments.id, deployment.deploymentId));
    expect(storedDeployment).toMatchObject({ attempt: 2, startedAt: expect.any(Date) });
    await expect(store.listDispatchable({ limit: 10 })).resolves.toEqual([]);
  });

  it("atomically transitions a valid leased claim and completes its work item", async () => {
    const deployment = await seedDeployment();
    const job = await ensureClaim(deployment, 3, new Date(0));
    const claimed = await claim(job.id, { leaseDurationMs: 60_000 });
    if (claimed.kind !== "claimed") {
      throw new Error(`Expected claim, received ${claimed.kind}`);
    }

    await expect(
      store.completeClaimTransition({
        leaseToken: claimed.lease.leaseToken,
        workItemId: job.id,
      }),
    ).resolves.toMatchObject({
      kind: "completed",
      transition: {
        deploymentId: deployment.deploymentId,
        eventSequence: 1,
        from: "queued",
        idempotentReplay: false,
        to: "cloning",
        version: 2,
      },
    });

    const [storedDeployment] = await client.db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, deployment.deploymentId));
    const [storedJob] = await client.db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.id, job.id));
    const sourceJobs = await client.db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.deploymentId, deployment.deploymentId));
    const sourceJob = sourceJobs.find(({ kind }) => kind === "deployment.prepare_source");
    expect(storedDeployment).toMatchObject({ eventSequence: 1, state: "cloning", version: 2 });
    expect(storedJob).toMatchObject({
      completedAt: expect.any(Date),
      deadLetteredAt: null,
      heartbeatAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      leaseExpiresAt: null,
      leaseToken: null,
      status: "completed",
      workerId: null,
    });
    expect(sourceJob).toMatchObject({
      attemptCount: 0,
      kind: "deployment.prepare_source",
      maxAttempts: 3,
      status: "pending",
    });

    const [events, commands, audits] = await Promise.all([
      client.db
        .select()
        .from(schema.deploymentEvents)
        .where(eq(schema.deploymentEvents.deploymentId, deployment.deploymentId)),
      client.db
        .select()
        .from(schema.deploymentCommands)
        .where(eq(schema.deploymentCommands.deploymentId, deployment.deploymentId)),
      client.db
        .select()
        .from(schema.auditEvents)
        .where(eq(schema.auditEvents.targetId, deployment.deploymentId)),
    ]);
    expect(events).toHaveLength(1);
    expect(commands).toHaveLength(1);
    expect(audits).toHaveLength(1);
  });

  it("uses the PostgreSQL clock and rejects stale or expired leases without transitioning", async () => {
    const staleDeployment = await seedDeployment();
    const staleJob = await ensureClaim(staleDeployment, 3, new Date(0));
    const staleClaim = await claim(staleJob.id, { leaseDurationMs: 60_000 });
    if (staleClaim.kind !== "claimed") {
      throw new Error(`Expected claim, received ${staleClaim.kind}`);
    }

    await expect(
      store.completeClaimTransition({ leaseToken: randomUUID(), workItemId: staleJob.id }),
    ).resolves.toEqual({ kind: "lease_mismatch" });

    const expiredDeployment = await seedDeployment();
    const expiredJob = await ensureClaim(expiredDeployment, 3, new Date(0));
    const expiredClaim = await claim(expiredJob.id, { leaseDurationMs: 60_000 });
    if (expiredClaim.kind !== "claimed") {
      throw new Error(`Expected expired claim fixture, received ${expiredClaim.kind}`);
    }
    await expireLease(expiredJob.id);
    await expect(
      store.completeClaimTransition({
        leaseToken: expiredClaim.lease.leaseToken,
        workItemId: expiredJob.id,
      }),
    ).resolves.toEqual({ kind: "lease_expired" });

    const unchangedDeployments = await client.db
      .select({ eventSequence: schema.deployments.eventSequence, state: schema.deployments.state })
      .from(schema.deployments)
      .where(
        inArray(schema.deployments.id, [
          staleDeployment.deploymentId,
          expiredDeployment.deploymentId,
        ]),
      );
    expect(unchangedDeployments).toHaveLength(2);
    expect(
      unchangedDeployments.every(
        (deployment) => deployment.eventSequence === 0 && deployment.state === "queued",
      ),
    ).toBe(true);
    await expect(client.db.select().from(schema.deploymentEvents)).resolves.toHaveLength(0);
  });

  it("rolls back a transition when the lease expires before the final fenced completion", async () => {
    const deployment = await seedDeployment();
    const job = await ensureClaim(deployment, 3, new Date(0));
    const claimed = await claim(job.id, { leaseDurationMs: 250 });
    if (claimed.kind !== "claimed") {
      throw new Error(`Expected claim, received ${claimed.kind}`);
    }

    const leaseValidated = deferred();
    const releaseCompletion = deferred();
    const synchronizedStore = new PostgresDeploymentJobStore(client.db, {
      afterInitialClaimLeaseValidation: async () => {
        leaseValidated.resolve();
        await releaseCompletion.promise;
      },
    });
    const completion = synchronizedStore.completeClaimTransition({
      leaseToken: claimed.lease.leaseToken,
      workItemId: job.id,
    });
    await leaseValidated.promise;
    await waitForDatabaseTime(claimed.lease.leaseExpiresAt);
    releaseCompletion.resolve();

    await expect(completion).resolves.toEqual({ kind: "lease_expired" });
    const [storedDeployment] = await client.db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, deployment.deploymentId));
    const [storedJob] = await client.db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.id, job.id));
    expect(storedDeployment).toMatchObject({ eventSequence: 0, state: "queued", version: 1 });
    expect(storedJob).toMatchObject({
      completedAt: null,
      leaseToken: claimed.lease.leaseToken,
      status: "running",
    });
    await expect(client.db.select().from(schema.deploymentEvents)).resolves.toHaveLength(0);
    await expect(client.db.select().from(schema.deploymentCommands)).resolves.toHaveLength(0);
    await expect(client.db.select().from(schema.auditEvents)).resolves.toHaveLength(0);
  });

  it("finishes an idempotently replayed transition and treats completed work as terminal", async () => {
    const deployment = await seedDeployment();
    const job = await ensureClaim(deployment, 3, new Date(0));
    const claimed = await claim(job.id, { leaseDurationMs: 60_000 });
    if (claimed.kind !== "claimed") {
      throw new Error(`Expected claim, received ${claimed.kind}`);
    }

    const transitionKey = `worker-claim-v1-${job.id}`;
    await expect(
      transitionStore.transition({
        deploymentId: deployment.deploymentId,
        idempotencyKey: transitionKey,
        organizationId: deployment.organizationId,
        to: "cloning",
      }),
    ).resolves.toMatchObject({ idempotentReplay: false });

    await expect(
      store.completeClaimTransition({
        leaseToken: claimed.lease.leaseToken,
        workItemId: job.id,
      }),
    ).resolves.toMatchObject({
      kind: "completed",
      transition: { idempotentReplay: true, to: "cloning" },
    });
    await expect(
      store.completeClaimTransition({
        leaseToken: claimed.lease.leaseToken,
        workItemId: job.id,
      }),
    ).resolves.toEqual({ kind: "not_running", status: "completed" });

    await expect(
      client.db
        .select()
        .from(schema.deploymentEvents)
        .where(eq(schema.deploymentEvents.deploymentId, deployment.deploymentId)),
    ).resolves.toHaveLength(1);
    await expect(
      client.db
        .select()
        .from(schema.deploymentCommands)
        .where(eq(schema.deploymentCommands.deploymentId, deployment.deploymentId)),
    ).resolves.toHaveLength(1);
  });

  it("rejects an incompatible transition replay without completing the claim job", async () => {
    const deployment = await seedDeployment();
    const job = await ensureClaim(deployment, 3, new Date(0));
    const claimed = await claim(job.id, { leaseDurationMs: 60_000 });
    if (claimed.kind !== "claimed") {
      throw new Error(`Expected claim, received ${claimed.kind}`);
    }

    const transitionKey = `worker-claim-v1-${job.id}`;
    await transitionStore.transition({
      deploymentId: deployment.deploymentId,
      idempotencyKey: transitionKey,
      organizationId: deployment.organizationId,
      to: "cancelling",
    });

    await expect(
      store.completeClaimTransition({
        leaseToken: claimed.lease.leaseToken,
        workItemId: job.id,
      }),
    ).rejects.toBeInstanceOf(DeploymentPersistenceConflictError);

    const [storedDeployment] = await client.db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, deployment.deploymentId));
    const [storedJob] = await client.db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.id, job.id));
    expect(storedDeployment).toMatchObject({ eventSequence: 1, state: "cancelling", version: 2 });
    expect(storedJob).toMatchObject({
      completedAt: null,
      leaseToken: claimed.lease.leaseToken,
      status: "running",
    });
    const events = await client.db
      .select()
      .from(schema.deploymentEvents)
      .where(eq(schema.deploymentEvents.deploymentId, deployment.deploymentId));
    expect(events).toEqual([expect.objectContaining({ toState: "cancelling" })]);
  });

  it("rolls back the transition when atomic work-item completion cannot commit", async () => {
    const deployment = await seedDeployment();
    const job = await ensureClaim(deployment, 3, new Date(0));
    const claimed = await claim(job.id, { leaseDurationMs: 60_000 });
    if (claimed.kind !== "claimed") {
      throw new Error(`Expected claim, received ${claimed.kind}`);
    }
    await client.db.insert(schema.deploymentEvents).values({
      deploymentId: deployment.deploymentId,
      fromState: null,
      kind: "forced_atomic_conflict",
      organizationId: deployment.organizationId,
      sequence: 1,
      toState: "queued",
    });

    await expect(
      store.completeClaimTransition({
        leaseToken: claimed.lease.leaseToken,
        workItemId: job.id,
      }),
    ).rejects.toThrow();

    const [storedDeployment] = await client.db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, deployment.deploymentId));
    const [storedJob] = await client.db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.id, job.id));
    expect(storedDeployment).toMatchObject({ eventSequence: 0, state: "queued", version: 1 });
    expect(storedJob).toMatchObject({
      completedAt: null,
      leaseToken: claimed.lease.leaseToken,
      status: "running",
    });
    await expect(client.db.select().from(schema.deploymentCommands)).resolves.toHaveLength(0);
    await expect(client.db.select().from(schema.auditEvents)).resolves.toHaveLength(0);
  });

  it("honors retry availability and dead-letters exactly at exhaustion", async () => {
    const deployment = await seedDeployment();
    const job = await ensureClaim(deployment, 2);
    const first = await claim(job.id);
    if (first.kind !== "claimed") {
      throw new Error(`Expected claim, received ${first.kind}`);
    }

    await expect(
      store.fail({
        leaseToken: first.lease.leaseToken,
        retryDelayMs: 10_000,
        safeErrorCode: "unsafe-code",
        safeErrorMessage: "canary-secret\nleak",
        workItemId: job.id,
      }),
    ).rejects.toBeInstanceOf(RangeError);

    await expect(
      store.fail({
        leaseToken: first.lease.leaseToken,
        retryDelayMs: -1,
        safeErrorCode: "infrastructure_unavailable",
        safeErrorMessage: "The queue dependency was temporarily unavailable",
        workItemId: job.id,
      }),
    ).rejects.toBeInstanceOf(RangeError);

    const retryCalculationStartedAt = await databaseNow();
    const retry = await store.fail({
      leaseToken: first.lease.leaseToken,
      retryDelayMs: 10_000,
      safeErrorCode: "infrastructure_unavailable",
      safeErrorMessage: "The queue dependency was temporarily unavailable",
      workItemId: job.id,
    });
    const retryCalculationFinishedAt = await databaseNow();
    expect(retry.kind).toBe("retry_scheduled");
    if (retry.kind !== "retry_scheduled") {
      throw new Error(`Expected scheduled retry, received ${retry.kind}`);
    }
    expect(retry).toMatchObject({ attemptCount: 1 });
    expect(retry.availableAt.getTime()).toBeGreaterThanOrEqual(
      retryCalculationStartedAt.getTime() + 10_000,
    );
    expect(retry.availableAt.getTime()).toBeLessThanOrEqual(
      retryCalculationFinishedAt.getTime() + 10_000,
    );
    await expect(store.listDispatchable({ limit: 10 })).resolves.toEqual([]);
    await expect(claim(job.id)).resolves.toEqual({
      availableAt: retry.availableAt,
      kind: "not_due",
    });
    await makeAvailable(job.id);
    await expect(store.listDispatchable({ limit: 10 })).resolves.toEqual([
      { contractVersion: 1, id: job.id, kind: "deployment.claim" },
    ]);

    const second = await claim(job.id);
    if (second.kind !== "claimed") {
      throw new Error(`Expected retry claim, received ${second.kind}`);
    }
    await expect(
      store.fail({
        leaseToken: second.lease.leaseToken,
        retryDelayMs: 30_000,
        safeErrorCode: "infrastructure_unavailable",
        safeErrorMessage: "The queue dependency was temporarily unavailable",
        workItemId: job.id,
      }),
    ).resolves.toEqual({ attemptCount: 2, kind: "dead_lettered" });
    await expect(claim(job.id)).resolves.toEqual({ kind: "dead_lettered" });
    await expect(store.listDispatchable({ limit: 10 })).resolves.toEqual([]);
    await expect(store.recoverExpired({ limit: 10 })).resolves.toEqual([]);

    const [stored] = await client.db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.id, job.id));
    expect(stored).toMatchObject({
      attemptCount: 2,
      deadLetteredAt: expect.any(Date),
      lastErrorCode: "infrastructure_unavailable",
      status: "dead_lettered",
    });
  });

  it("dead-letters an expired final lease and terminally completes stale pending, retry, and running work", async () => {
    const deployment = await seedDeployment();
    const job = await ensureClaim(deployment, 1);
    await claim(job.id, { leaseDurationMs: 5_000 });
    await expireLease(job.id);

    await expect(store.recoverExpired({ limit: 10 })).resolves.toEqual([
      { id: job.id, status: "dead_lettered" },
    ]);
    await expect(store.listDispatchable({ limit: 10 })).resolves.toEqual([]);

    const pendingDeployment = await seedDeployment();
    const pendingJob = await ensureClaim(pendingDeployment);
    await client.db
      .update(schema.deployments)
      .set({ finishedAt: start, state: "cancelled" })
      .where(eq(schema.deployments.id, pendingDeployment.deploymentId));
    await expect(claim(pendingJob.id)).resolves.toEqual({ kind: "completed" });

    const runningDeployment = await seedDeployment();
    const runningJob = await ensureClaim(runningDeployment);
    const runningClaim = await claim(runningJob.id);
    if (runningClaim.kind !== "claimed") {
      throw new Error(`Expected running claim, received ${runningClaim.kind}`);
    }
    await client.db
      .update(schema.deployments)
      .set({ state: "cloning" })
      .where(eq(schema.deployments.id, runningDeployment.deploymentId));
    await expect(claim(runningJob.id)).resolves.toEqual({
      kind: "completed",
    });

    const retryDeployment = await seedDeployment();
    const retryJob = await ensureClaim(retryDeployment);
    const retryClaim = await claim(retryJob.id);
    if (retryClaim.kind !== "claimed") {
      throw new Error(`Expected retry claim, received ${retryClaim.kind}`);
    }
    await store.fail({
      leaseToken: retryClaim.lease.leaseToken,
      retryDelayMs: 2_000,
      safeErrorCode: "infrastructure_unavailable",
      safeErrorMessage: "The queue dependency was temporarily unavailable",
      workItemId: retryJob.id,
    });
    await client.db
      .update(schema.deployments)
      .set({ state: "building" })
      .where(eq(schema.deployments.id, retryDeployment.deploymentId));
    await expect(claim(retryJob.id)).resolves.toEqual({
      kind: "completed",
    });

    const storedTerminalJobs = await client.db
      .select()
      .from(schema.deploymentJobs)
      .where(inArray(schema.deploymentJobs.id, [pendingJob.id, runningJob.id, retryJob.id]));
    expect(storedTerminalJobs).toHaveLength(3);
    for (const stored of storedTerminalJobs) {
      expect(stored).toMatchObject({
        completedAt: expect.any(Date),
        deadLetteredAt: null,
        heartbeatAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
        leaseExpiresAt: null,
        leaseToken: null,
        status: "completed",
        workerId: null,
      });
    }
    expect(storedTerminalJobs.find(({ id }) => id === pendingJob.id)?.attemptCount).toBe(0);
  });

  it("binds source work to its queue kind and loads immutable preparation input", async () => {
    const deployment = await seedDeployment();
    const sourceJob = await enterCloning(deployment);

    await expect(claim(sourceJob.id)).resolves.toEqual({
      actualKind: "deployment.prepare_source",
      kind: "kind_mismatch",
    });
    const [stillPending] = await client.db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.id, sourceJob.id));
    expect(stillPending).toMatchObject({ attemptCount: 0, status: "pending" });

    const claimed = await claim(sourceJob.id, { expectedKind: "deployment.prepare_source" });
    if (claimed.kind !== "claimed") {
      throw new Error(`Expected source work lease, received ${claimed.kind}`);
    }
    expect(claimed.lease.kind).toBe("deployment.prepare_source");
    await expect(
      store.loadSourcePreparation({
        leaseToken: claimed.lease.leaseToken,
        workItemId: sourceJob.id,
      }),
    ).resolves.toEqual({
      kind: "loaded",
      source: {
        deploymentId: deployment.deploymentId,
        dockerfilePath: "Dockerfile",
        organizationId: deployment.organizationId,
        repositoryName: `repository-${deployment.projectId.slice(0, 8)}`,
        repositoryOwner: "launchrail-test",
        repositoryProvider: "github",
        requestedRevision: "main",
        resolvedRevision: deployment.sourceRevision,
        workItemId: sourceJob.id,
      },
    });
  });

  it("refuses to lease source work before the deployment reaches cloning", async () => {
    const deployment = await seedDeployment();
    const [sourceJob] = await client.db
      .insert(schema.deploymentJobs)
      .values({
        deploymentId: deployment.deploymentId,
        kind: "deployment.prepare_source",
        maxAttempts: 3,
        organizationId: deployment.organizationId,
      })
      .returning();
    if (sourceJob === undefined) {
      throw new Error("Expected source job insert");
    }

    await expect(
      claim(sourceJob.id, { expectedKind: "deployment.prepare_source" }),
    ).resolves.toEqual({ kind: "state_mismatch", state: "queued" });
    const [stored] = await client.db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.id, sourceJob.id));
    expect(stored).toMatchObject({ attemptCount: 0, status: "pending" });
  });

  it("lease-fences portable source metadata with the cloning-to-building transition", async () => {
    const deployment = await seedDeployment();
    const sourceJob = await enterCloning(deployment);
    const claimed = await claim(sourceJob.id, { expectedKind: "deployment.prepare_source" });
    if (claimed.kind !== "claimed") {
      throw new Error(`Expected source work lease, received ${claimed.kind}`);
    }
    const metadata = {
      checkoutId: deployment.deploymentId,
      dockerfilePath: "Dockerfile",
      dockerfileResolvedPath: "deploy/Δockerfile",
      dockerfileSha256: "d".repeat(64),
      fileCount: 12,
      resolvedRevision: deployment.sourceRevision,
      totalBytes: 4_096,
      treeRevision: "e".repeat(40),
    } as const;

    await expect(
      store.completeSourcePreparation({
        leaseToken: claimed.lease.leaseToken,
        metadata: { ...metadata, resolvedRevision: "f".repeat(40) },
        workItemId: sourceJob.id,
      }),
    ).resolves.toEqual({ kind: "source_mismatch" });

    const completed = await store.completeSourcePreparation({
      leaseToken: claimed.lease.leaseToken,
      metadata,
      workItemId: sourceJob.id,
    });
    expect(completed).toMatchObject({
      kind: "completed",
      source: metadata,
      transition: { from: "cloning", to: "building" },
    });
    const [storedDeployment] = await client.db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, deployment.deploymentId));
    const [storedSource] = await client.db
      .select()
      .from(schema.deploymentSourcePreparations)
      .where(eq(schema.deploymentSourcePreparations.deploymentId, deployment.deploymentId));
    const [storedJob] = await client.db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.id, sourceJob.id));
    expect(storedDeployment).toMatchObject({ eventSequence: 2, state: "building" });
    expect(storedSource).toMatchObject({ ...metadata, preparedAt: expect.any(Date) });
    expect(storedJob).toMatchObject({ completedAt: expect.any(Date), status: "completed" });
    let mutationError: unknown;
    try {
      await client.db
        .update(schema.deploymentSourcePreparations)
        .set({ fileCount: 13 })
        .where(eq(schema.deploymentSourcePreparations.deploymentId, deployment.deploymentId));
    } catch (error) {
      mutationError = error;
    }
    expect(findDatabaseError(mutationError)).toEqual({
      code: "23514",
      message: "prepared deployment source metadata is immutable",
    });
  });

  it("rolls back source metadata and transition when the final lease fence expires", async () => {
    const deployment = await seedDeployment();
    const sourceJob = await enterCloning(deployment);
    const claimed = await claim(sourceJob.id, {
      expectedKind: "deployment.prepare_source",
      leaseDurationMs: 250,
    });
    if (claimed.kind !== "claimed") {
      throw new Error(`Expected source work lease, received ${claimed.kind}`);
    }
    const leaseValidated = deferred();
    const releaseCompletion = deferred();
    const synchronizedStore = new PostgresDeploymentJobStore(client.db, {
      afterInitialSourceLeaseValidation: async () => {
        leaseValidated.resolve();
        await releaseCompletion.promise;
      },
    });
    const completion = synchronizedStore.completeSourcePreparation({
      leaseToken: claimed.lease.leaseToken,
      metadata: {
        checkoutId: deployment.deploymentId,
        dockerfilePath: "Dockerfile",
        dockerfileResolvedPath: "Dockerfile",
        dockerfileSha256: "d".repeat(64),
        fileCount: 2,
        resolvedRevision: deployment.sourceRevision,
        totalBytes: 512,
        treeRevision: "e".repeat(40),
      },
      workItemId: sourceJob.id,
    });
    await leaseValidated.promise;
    await waitForDatabaseTime(claimed.lease.leaseExpiresAt);
    releaseCompletion.resolve();

    await expect(completion).resolves.toEqual({ kind: "lease_expired" });
    const [storedDeployment] = await client.db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, deployment.deploymentId));
    const [storedJob] = await client.db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.id, sourceJob.id));
    expect(storedDeployment).toMatchObject({ eventSequence: 1, state: "cloning", version: 2 });
    expect(storedJob).toMatchObject({
      completedAt: null,
      leaseToken: claimed.lease.leaseToken,
      status: "running",
    });
    await expect(client.db.select().from(schema.deploymentSourcePreparations)).resolves.toEqual([]);
    await expect(
      client.db
        .select()
        .from(schema.deploymentEvents)
        .where(eq(schema.deploymentEvents.deploymentId, deployment.deploymentId)),
    ).resolves.toHaveLength(1);
  });

  it("terminally records permanent source failures without fabricating attempts", async () => {
    const deployment = await seedDeployment();
    const sourceJob = await enterCloning(deployment, 4);
    const claimed = await claim(sourceJob.id, { expectedKind: "deployment.prepare_source" });
    if (claimed.kind !== "claimed") {
      throw new Error(`Expected source work lease, received ${claimed.kind}`);
    }

    await expect(
      store.failSourcePreparation({
        failure: {
          category: "dockerfile_missing",
          message: "The configured Dockerfile was not found in the prepared checkout",
        },
        leaseToken: claimed.lease.leaseToken,
        retryable: false,
        retryDelayMs: 0,
        workItemId: sourceJob.id,
      }),
    ).resolves.toMatchObject({
      attemptCount: 1,
      kind: "dead_lettered",
      transition: { from: "cloning", to: "build_failed" },
    });
    const [storedJob] = await client.db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.id, sourceJob.id));
    const [storedDeployment] = await client.db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, deployment.deploymentId));
    expect(storedJob).toMatchObject({ attemptCount: 1, maxAttempts: 4, status: "dead_lettered" });
    expect(storedDeployment).toMatchObject({
      failureCategory: "dockerfile_missing",
      state: "build_failed",
    });
  });

  it("retries transient source failures and fails an exhausted expired lease atomically", async () => {
    const deployment = await seedDeployment();
    const sourceJob = await enterCloning(deployment, 2);
    const first = await claim(sourceJob.id, { expectedKind: "deployment.prepare_source" });
    if (first.kind !== "claimed") {
      throw new Error(`Expected source work lease, received ${first.kind}`);
    }
    await expect(
      store.failSourcePreparation({
        failure: {
          category: "source_unavailable",
          message: "The public repository was temporarily unavailable",
        },
        leaseToken: first.lease.leaseToken,
        retryable: true,
        retryDelayMs: 1,
        workItemId: sourceJob.id,
      }),
    ).resolves.toMatchObject({ attemptCount: 1, kind: "retry_scheduled" });
    await makeAvailable(sourceJob.id);
    const second = await claim(sourceJob.id, { expectedKind: "deployment.prepare_source" });
    if (second.kind !== "claimed") {
      throw new Error(`Expected second source work lease, received ${second.kind}`);
    }
    await expireLease(sourceJob.id);

    await expect(store.recoverExpired({ limit: 10 })).resolves.toContainEqual({
      id: sourceJob.id,
      status: "dead_lettered",
    });
    const [storedJob] = await client.db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.id, sourceJob.id));
    const [storedDeployment] = await client.db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, deployment.deploymentId));
    expect(storedJob).toMatchObject({ attemptCount: 2, status: "dead_lettered" });
    expect(storedDeployment).toMatchObject({
      failureCategory: "infrastructure_unavailable",
      state: "build_failed",
    });
  });

  it("terminally fails an exhausted source lease when a duplicate wake-up wins recovery", async () => {
    const deployment = await seedDeployment();
    const sourceJob = await enterCloning(deployment, 1);
    const first = await claim(sourceJob.id, { expectedKind: "deployment.prepare_source" });
    if (first.kind !== "claimed") {
      throw new Error(`Expected source work lease, received ${first.kind}`);
    }
    await expireLease(sourceJob.id);

    await expect(
      claim(sourceJob.id, { expectedKind: "deployment.prepare_source" }),
    ).resolves.toEqual({ kind: "dead_lettered" });
    const [storedDeployment] = await client.db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, deployment.deploymentId));
    expect(storedDeployment).toMatchObject({
      failureCategory: "infrastructure_unavailable",
      state: "build_failed",
    });
  });

  it("reconciles missing source work only for deployments already cloning", async () => {
    const cloning = await seedDeployment({ state: "cloning" });
    const queued = await seedDeployment();
    const created = await store.ensureMissing({ limit: 10, maxAttempts: 3 });
    expect(created).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          deploymentId: cloning.deploymentId,
          kind: "deployment.prepare_source",
        }),
        expect.objectContaining({ deploymentId: queued.deploymentId, kind: "deployment.claim" }),
      ]),
    );
    expect(created).toHaveLength(2);
  });

  it("persists worker lifecycle, freshness, and terminal status without reopening instances", async () => {
    const workerClockLowerBound = await databaseNow();
    const created = await store.recordWorkerHeartbeat({
      activeJobCount: 0,
      status: "starting",
      version: "0.1.0",
      workerId: "worker-fresh",
    });
    const workerClockUpperBound = await databaseNow();
    expect(created).toMatchObject({ kind: "created", worker: { freshness: "fresh" } });
    if (created.kind !== "created") {
      throw new Error(`Expected worker heartbeat creation, received ${created.kind}`);
    }
    expect(created.worker.startedAt.getTime()).toBeGreaterThanOrEqual(
      workerClockLowerBound.getTime(),
    );
    expect(created.worker.startedAt.getTime()).toBeLessThanOrEqual(workerClockUpperBound.getTime());
    expect(created.worker.heartbeatAt).toEqual(created.worker.startedAt);
    await store.recordWorkerHeartbeat({
      activeJobCount: 0,
      status: "starting",
      version: "0.1.0",
      workerId: "worker-stale",
    });
    await client.db
      .update(schema.workerHeartbeats)
      .set({
        heartbeatAt: sql`clock_timestamp() - interval '10 seconds'`,
        startedAt: sql`clock_timestamp() - interval '10 seconds'`,
        updatedAt: sql`clock_timestamp() - interval '10 seconds'`,
      })
      .where(eq(schema.workerHeartbeats.workerId, "worker-stale"));
    await store.recordWorkerHeartbeat({
      activeJobCount: 2,
      status: "ready",
      version: "0.1.0",
      workerId: "worker-fresh",
    });

    await expect(
      store.recordWorkerHeartbeat({
        activeJobCount: 2,
        status: "starting",
        version: "0.1.0",
        workerId: "worker-fresh",
      }),
    ).resolves.toEqual({
      currentStatus: "ready",
      kind: "invalid_transition",
      requestedStatus: "starting",
    });
    await expect(
      store.recordWorkerHeartbeat({
        activeJobCount: 2,
        status: "ready",
        version: "0.2.0",
        workerId: "worker-fresh",
      }),
    ).resolves.toEqual({ kind: "version_mismatch" });

    const observed = await store.listWorkerHeartbeats({ staleAfterMs: 5_000 });
    expect(observed).toHaveLength(2);
    expect(observed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ freshness: "fresh", workerId: "worker-fresh" }),
        expect.objectContaining({ freshness: "stale", workerId: "worker-stale" }),
      ]),
    );

    await store.recordWorkerHeartbeat({
      activeJobCount: 1,
      status: "draining",
      version: "0.1.0",
      workerId: "worker-fresh",
    });
    await store.recordWorkerHeartbeat({
      activeJobCount: 0,
      status: "stopped",
      version: "0.1.0",
      workerId: "worker-fresh",
    });
    await expect(
      store.recordWorkerHeartbeat({
        activeJobCount: 0,
        status: "ready",
        version: "0.1.0",
        workerId: "worker-fresh",
      }),
    ).resolves.toMatchObject({ currentStatus: "stopped", kind: "invalid_transition" });

    const stopped = await store.listWorkerHeartbeats({ staleAfterMs: 5_000 });
    expect(stopped.find(({ workerId }) => workerId === "worker-fresh")).toMatchObject({
      activeJobCount: 0,
      freshness: "stopped",
      status: "stopped",
      stoppedAt: expect.any(Date),
    });
  });

  it("enforces ownership and rejects malformed durable lease and heartbeat state", async () => {
    const first = await seedDeployment();
    const second = await seedDeployment();

    await expect(
      client.db.insert(schema.deploymentJobs).values({
        deploymentId: first.deploymentId,
        kind: "deployment.claim",
        maxAttempts: 3,
        organizationId: second.organizationId,
      }),
    ).rejects.toThrow();
    await expect(client.db.select().from(schema.deploymentJobs)).resolves.toHaveLength(0);

    await expect(
      client.db.insert(schema.deploymentJobs).values({
        attemptCount: 1,
        deploymentId: first.deploymentId,
        heartbeatAt: start,
        kind: "deployment.claim",
        maxAttempts: 3,
        organizationId: first.organizationId,
        status: "running",
      }),
    ).rejects.toThrow();
    await expect(client.db.select().from(schema.deploymentJobs)).resolves.toHaveLength(0);

    await expect(
      client.db.insert(schema.deploymentJobs).values({
        attemptCount: 1,
        deploymentId: first.deploymentId,
        kind: "deployment.claim",
        maxAttempts: 3,
        organizationId: first.organizationId,
        status: "retry_wait",
      }),
    ).rejects.toThrow();
    await expect(client.db.select().from(schema.deploymentJobs)).resolves.toHaveLength(0);

    await expect(
      client.db.insert(schema.deploymentJobs).values({
        deploymentId: first.deploymentId,
        kind: "deployment.claim",
        lastErrorCode: "orphaned_code",
        maxAttempts: 3,
        organizationId: first.organizationId,
      }),
    ).rejects.toThrow();
    await expect(client.db.select().from(schema.deploymentJobs)).resolves.toHaveLength(0);

    await expect(
      client.db.insert(schema.deploymentJobs).values({
        deploymentId: first.deploymentId,
        kind: "deployment.claim",
        lastErrorMessage: "Orphaned safe failure message",
        maxAttempts: 3,
        organizationId: first.organizationId,
      }),
    ).rejects.toThrow();
    await expect(client.db.select().from(schema.deploymentJobs)).resolves.toHaveLength(0);

    await expect(
      client.db.insert(schema.workerHeartbeats).values({
        activeJobCount: 1,
        heartbeatAt: start,
        startedAt: start,
        status: "stopped",
        stoppedAt: start,
        version: "0.1.0",
        workerId: "worker-invalid",
      }),
    ).rejects.toThrow();
    await expect(client.db.select().from(schema.workerHeartbeats)).resolves.toHaveLength(0);
  });
});
