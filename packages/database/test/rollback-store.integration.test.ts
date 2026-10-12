import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createDatabaseClient,
  PostgresRollbackStore,
  PostgresDeploymentJobStore,
  PostgresDeploymentTransitionStore,
  schema,
} from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;
(databaseUrl ? describe : describe.skip)("Durable health-gated rollback", () => {
  if (!databaseUrl) return;
  const client = createDatabaseClient(databaseUrl);
  const store = new PostgresRollbackStore(client.db);
  const jobs = new PostgresDeploymentJobStore(client.db);
  let organizationId: string;
  let projectId: string;
  let sourceId: string;
  let targetId: string;
  let runtimeJobId: string;
  const digest = `sha256:${"a".repeat(64)}`;
  const runtime = {
    containerId: "b".repeat(64),
    hostPort: 43001,
    imageDigest: digest,
    resourceMetadata: {},
  };
  const config = {
    defaultBranch: "main",
    dockerfilePath: "Dockerfile",
    healthCheckPath: "/health",
    healthCheckPort: 3000,
    runtimeConfig: {
      cpuMillicores: 500,
      memoryMegabytes: 512,
      processLimit: 128,
      readOnlyRootFilesystem: true,
    },
  };
  const command = () => ({
    deploymentId: sourceId,
    organizationId,
    idempotencyKey: "acceptance-rollback",
  });
  const claim = () => store.claim({ workerId: "rollback-test", leaseDurationMs: 30000 });
  const success = () => ({
    runtime,
    healthCheckedAt: new Date(),
    healthDurationMs: 4,
    healthStatusCode: 204,
  });
  beforeAll(async () => {
    await migrate(client.db, {
      migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
    });
  });
  beforeEach(async () => {
    await client.db.execute(sql`truncate users, organizations cascade`);
    organizationId = randomUUID();
    projectId = randomUUID();
    sourceId = randomUUID();
    targetId = randomUUID();
    runtimeJobId = randomUUID();
    await client.db
      .insert(schema.organizations)
      .values({ id: organizationId, name: "Rollback acceptance", slug: "rollback-acceptance" });
    await client.db.insert(schema.projects).values({
      id: projectId,
      organizationId,
      name: "Rollback app",
      repositoryOwner: "launchrail",
      repositoryName: "fixture",
      ...config,
    });
    await client.db.insert(schema.deployments).values([
      {
        id: sourceId,
        projectId,
        organizationId,
        sourceRevision: "c".repeat(40),
        configurationSnapshot: config,
        sourceSnapshot: {},
        state: "active",
        healthCheckedAt: new Date(),
      },
      {
        id: targetId,
        projectId,
        organizationId,
        sourceRevision: "c".repeat(40),
        configurationSnapshot: config,
        sourceSnapshot: {},
        state: "superseded",
        healthCheckedAt: new Date(),
      },
    ]);
    await client.db
      .insert(schema.activeReleases)
      .values({ projectId, organizationId, deploymentId: sourceId });
    const buildJobId = randomUUID();
    await client.db.insert(schema.deploymentJobs).values([
      {
        id: buildJobId,
        deploymentId: targetId,
        organizationId,
        kind: "deployment.build",
        maxAttempts: 3,
        status: "completed",
        attemptCount: 1,
        completedAt: new Date(),
      },
      {
        id: runtimeJobId,
        deploymentId: targetId,
        organizationId,
        kind: "deployment.start_runtime",
        maxAttempts: 3,
        status: "completed",
        attemptCount: 1,
        completedAt: new Date(),
      },
    ]);
    const source = {
      deploymentId: targetId,
      organizationId,
      checkoutId: targetId,
      resolvedRevision: "c".repeat(40),
      treeRevision: "d".repeat(40),
      dockerfileSha256: "e".repeat(64),
      contextSha256: "f".repeat(64),
    };
    await client.db.insert(schema.deploymentSourcePreparations).values({
      ...source,
      fileCount: 1,
      totalBytes: 128,
      dockerfilePath: "Dockerfile",
      dockerfileResolvedPath: "Dockerfile",
    });
    await client.db.insert(schema.deploymentBuildArtifacts).values({
      deploymentId: targetId,
      organizationId,
      checkoutId: targetId,
      sourceRevision: source.resolvedRevision,
      treeRevision: source.treeRevision,
      dockerfileSha256: source.dockerfileSha256,
      contextSha256: source.contextSha256,
      workItemId: buildJobId,
      imageReference: `launchrail/deployment:${targetId}`,
      imageId: digest,
      manifestDigest: digest,
      platform: "linux/amd64",
      imageSizeBytes: 128,
      cacheHitCount: 0,
      cacheMissCount: 1,
    });
    await client.db.insert(schema.runtimeInstances).values({
      deploymentId: sourceId,
      organizationId,
      containerId: "c".repeat(64),
      imageDigest: digest,
      state: "running",
      hostPort: 43000,
    });
    await client.db.insert(schema.previewRoutes).values({
      deploymentId: sourceId,
      organizationId,
      hostname: `d-${sourceId}.localhost`,
      hostPort: 43000,
    });
  });
  afterAll(async () => {
    await client.close();
  });

  it("persists and deduplicates preparation while retaining the current route", async () => {
    expect(
      await new PostgresDeploymentTransitionStore(client.db).rollback(command()),
    ).toMatchObject({ to: "rolling_back", idempotentReplay: false });
    expect(await store.request(command())).toMatchObject({
      to: "rolling_back",
      idempotentReplay: true,
    });
    expect(await client.db.select().from(schema.rollbackRequests)).toHaveLength(1);
    expect((await client.db.select().from(schema.activeReleases))[0]?.deploymentId).toBe(sourceId);
    expect(await jobs.listRoutableRuntimes()).toHaveLength(1);
  });
  it("switches only after a live lease supplies fresh health and immutable target configuration", async () => {
    await store.request(command());
    await client.db
      .update(schema.projects)
      .set({ healthCheckPath: "/edited" })
      .where(eq(schema.projects.id, projectId));
    const lease = await claim();
    expect(lease).not.toBeNull();
    if (!lease) return;
    expect(lease.runtime).toMatchObject({
      healthCheckPath: "/health",
      workItemId: runtimeJobId,
      imageId: digest,
    });
    const resources = await jobs.listWorkerResourceRecoveryState();
    expect(resources.leasedRuntimeDeploymentIds).toEqual(
      expect.arrayContaining([sourceId, targetId]),
    );
    expect(resources.leasedWorkItemIds).toContain(runtimeJobId);
    expect(await store.finish({ ...lease, result: success() })).toBe(true);
    expect(await store.finish({ ...lease, result: success() })).toBe(false);
    expect((await client.db.select().from(schema.activeReleases))[0]?.deploymentId).toBe(targetId);
    expect((await client.db.select().from(schema.healthCheckAttempts))[0]?.statusCode).toBe(204);
    expect(
      (
        await client.db
          .select()
          .from(schema.previewRoutes)
          .where(eq(schema.previewRoutes.deploymentId, targetId))
      )[0]?.hostPort,
    ).toBe(43001);
    expect(
      (
        await client.db.select().from(schema.deployments).where(eq(schema.deployments.id, sourceId))
      )[0]?.state,
    ).toBe("rolled_back");
  });
  it("retains the current release and durably cleans an unhealthy prepared target", async () => {
    await store.request(command());
    const lease = await claim();
    if (!lease) throw new Error("Missing lease");
    expect(
      await store.finish({ ...lease, result: { errorCode: "rollback_unhealthy", runtime } }),
    ).toBe(true);
    expect((await client.db.select().from(schema.activeReleases))[0]?.deploymentId).toBe(sourceId);
    expect(
      (
        await client.db.select().from(schema.deployments).where(eq(schema.deployments.id, sourceId))
      )[0]?.state,
    ).toBe("active");
    expect(
      (
        await client.db
          .select()
          .from(schema.runtimeInstances)
          .where(eq(schema.runtimeInstances.deploymentId, targetId))
      )[0],
    ).toMatchObject({ state: "failed", cleanupState: "pending" });
    expect((await client.db.select().from(schema.rollbackRequests))[0]).toMatchObject({
      status: "failed",
      errorCode: "rollback_unhealthy",
    });
  });
  it("fences a stale completion and reclaims interrupted preparation", async () => {
    await store.request(command());
    const first = await claim();
    if (!first) throw new Error("Missing lease");
    await client.db.update(schema.rollbackRequests).set({ leaseExpiresAt: new Date(0) });
    const second = await claim();
    if (!second) throw new Error("Missing replacement lease");
    expect(second.leaseToken).not.toBe(first.leaseToken);
    expect(await store.heartbeat({ ...first, leaseDurationMs: 30000 })).toBe(false);
    expect(await store.finish({ ...first, result: success() })).toBe(false);
    expect(await store.finish({ ...second, result: success() })).toBe(true);
  });
  it("restores the current release after bounded lease exhaustion", async () => {
    await store.request(command());
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(await claim()).not.toBeNull();
      await client.db.update(schema.rollbackRequests).set({ leaseExpiresAt: new Date(0) });
    }
    expect(await claim()).toBeNull();
    expect((await client.db.select().from(schema.rollbackRequests))[0]).toMatchObject({
      status: "failed",
      errorCode: "rollback_lease_exhausted",
      attemptCount: 3,
    });
    expect(
      (
        await client.db.select().from(schema.deployments).where(eq(schema.deployments.id, sourceId))
      )[0]?.state,
    ).toBe("active");
  });
  it("fails explicitly when retained image metadata is missing", async () => {
    await client.db
      .delete(schema.deploymentBuildArtifacts)
      .where(eq(schema.deploymentBuildArtifacts.deploymentId, targetId));
    await store.request(command());
    expect(await claim()).toBeNull();
    expect((await client.db.select().from(schema.rollbackRequests))[0]).toMatchObject({
      status: "failed",
      errorCode: "rollback_invalid_snapshot",
    });
    expect((await client.db.select().from(schema.activeReleases))[0]?.deploymentId).toBe(sourceId);
  });
  it("serializes conflicting requests and concurrent claims", async () => {
    const requests = await Promise.allSettled([
      store.request(command()),
      store.request({ ...command(), idempotencyKey: "another-command" }),
    ]);
    expect(requests.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const claims = await Promise.all([claim(), claim()]);
    expect(claims.filter(Boolean)).toHaveLength(1);
  });
  it("rejects stale health and mismatched image proofs without switching", async () => {
    await store.request(command());
    const lease = await claim();
    if (!lease) throw new Error("Missing lease");
    await expect(
      store.finish({ ...lease, result: { ...success(), healthCheckedAt: new Date(0) } }),
    ).rejects.toThrow("not fresh");
    await expect(
      store.finish({
        ...lease,
        result: { ...success(), runtime: { ...runtime, imageDigest: `sha256:${"d".repeat(64)}` } },
      }),
    ).rejects.toThrow("image identity");
    expect((await client.db.select().from(schema.activeReleases))[0]?.deploymentId).toBe(sourceId);
    expect(await store.finish({ ...lease, result: success() })).toBe(true);
  });
  it("retains the current release if the target is stopped during preparation", async () => {
    await store.request(command());
    const lease = await claim();
    if (!lease) throw new Error("Missing lease");
    await new PostgresDeploymentTransitionStore(client.db).transition({
      deploymentId: targetId,
      organizationId,
      idempotencyKey: "stop-target",
      to: "stopped",
    });
    expect(await store.finish({ ...lease, result: success() })).toBe(true);
    expect((await client.db.select().from(schema.activeReleases))[0]?.deploymentId).toBe(sourceId);
    expect(
      (
        await client.db.select().from(schema.deployments).where(eq(schema.deployments.id, sourceId))
      )[0]?.state,
    ).toBe("active");
    expect((await client.db.select().from(schema.rollbackRequests))[0]).toMatchObject({
      status: "failed",
      errorCode: "rollback_state_conflict",
    });
  });
  it("rechecks lease expiry after waiting for the project lock", async () => {
    await store.request(command());
    const lease = await store.claim({ workerId: "rollback-test", leaseDurationMs: 1000 });
    if (!lease) throw new Error("Missing lease");
    let release!: () => void;
    let locked!: () => void;
    const acquired = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transaction = client.db.transaction(async (tx) => {
      await tx
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, projectId))
        .for("update");
      locked();
      await hold;
    });
    await acquired;
    const completion = store.finish({ ...lease, result: success() });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    release();
    await transaction;
    expect(await completion).toBe(false);
    expect((await client.db.select().from(schema.activeReleases))[0]?.deploymentId).toBe(sourceId);
    const replacement = await claim();
    expect(replacement?.leaseToken).not.toBe(lease.leaseToken);
  });
});
