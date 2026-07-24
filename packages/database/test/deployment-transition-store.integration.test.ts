import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createDatabaseClient,
  DeploymentNotFoundError,
  DeploymentPersistenceConflictError,
  PostgresDeploymentTransitionStore,
  schema,
} from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;
const describeWithDatabase = databaseUrl === undefined ? describe.skip : describe;

describeWithDatabase("PostgresDeploymentTransitionStore", () => {
  if (databaseUrl === undefined) {
    return;
  }

  const client = createDatabaseClient(databaseUrl);
  const store = new PostgresDeploymentTransitionStore(client.db);

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

  async function seedDeployment(
    options: {
      healthChecked?: boolean;
      organizationId?: string;
      projectId?: string;
      state?: (typeof schema.deploymentState.enumValues)[number];
    } = {},
  ) {
    const organizationId = options.organizationId ?? randomUUID();
    const projectId = options.projectId ?? randomUUID();
    const deploymentId = randomUUID();

    if (options.organizationId === undefined) {
      await client.db.insert(schema.organizations).values({
        id: organizationId,
        name: `Organization ${organizationId.slice(0, 6)}`,
        slug: `org-${organizationId.slice(0, 12)}`,
      });
    }

    if (options.projectId === undefined) {
      await client.db.insert(schema.projects).values({
        healthCheckPort: 3000,
        id: projectId,
        name: `Project ${projectId.slice(0, 6)}`,
        organizationId,
        repositoryName: `repository-${projectId.slice(0, 8)}`,
        repositoryOwner: "launchrail-test",
        runtimeConfig: {},
      });
    }

    await client.db.insert(schema.deployments).values({
      configurationSnapshot: { environment: [] },
      healthCheckedAt:
        options.healthChecked === true ||
        options.state === "active" ||
        options.state === "superseded"
          ? new Date()
          : null,
      id: deploymentId,
      organizationId,
      projectId,
      sourceRevision: randomUUID().replaceAll("-", "").padEnd(40, "0"),
      sourceSnapshot: { branch: "main" },
      state: options.state ?? "queued",
    });

    return { deploymentId, organizationId, projectId };
  }

  it("persists a valid transition and event in one transaction", async () => {
    const seeded = await seedDeployment();

    await expect(
      store.transition({
        deploymentId: seeded.deploymentId,
        idempotencyKey: "worker-claim-1",
        organizationId: seeded.organizationId,
        to: "cloning",
      }),
    ).resolves.toMatchObject({
      eventSequence: 1,
      from: "queued",
      idempotentReplay: false,
      to: "cloning",
      version: 2,
    });

    const [deployment] = await client.db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, seeded.deploymentId));
    const events = await client.db
      .select()
      .from(schema.deploymentEvents)
      .where(eq(schema.deploymentEvents.deploymentId, seeded.deploymentId));
    const audits = await client.db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.targetId, seeded.deploymentId));

    expect(deployment).toMatchObject({
      eventSequence: 1,
      state: "cloning",
      version: 2,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      fromState: "queued",
      sequence: 1,
      toState: "cloning",
    });
    expect(audits).toHaveLength(1);
  });

  it("returns the stored result when an idempotency key is replayed", async () => {
    const seeded = await seedDeployment();
    const command = {
      deploymentId: seeded.deploymentId,
      idempotencyKey: "worker-claim-replay",
      organizationId: seeded.organizationId,
      to: "cloning" as const,
    };

    const first = await store.transition(command);
    const replay = await store.transition(command);

    expect(first.idempotentReplay).toBe(false);
    expect(replay).toEqual({ ...first, idempotentReplay: true });
    await expect(
      client.db
        .select()
        .from(schema.deploymentEvents)
        .where(eq(schema.deploymentEvents.deploymentId, seeded.deploymentId)),
    ).resolves.toHaveLength(1);
  });

  it("rolls back the state update when event persistence fails", async () => {
    const seeded = await seedDeployment();
    await client.db.insert(schema.deploymentEvents).values({
      deploymentId: seeded.deploymentId,
      fromState: null,
      kind: "test_conflict",
      organizationId: seeded.organizationId,
      sequence: 1,
      toState: "queued",
    });

    await expect(
      store.transition({
        deploymentId: seeded.deploymentId,
        idempotencyKey: "forced-event-conflict",
        organizationId: seeded.organizationId,
        to: "cloning",
      }),
    ).rejects.toThrow();

    const [deployment] = await client.db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, seeded.deploymentId));
    expect(deployment).toMatchObject({
      eventSequence: 0,
      state: "queued",
      version: 1,
    });
  });

  it("rejects invalid transitions without writing state or events", async () => {
    const seeded = await seedDeployment();

    await expect(
      store.transition({
        deploymentId: seeded.deploymentId,
        idempotencyKey: "skip-build",
        organizationId: seeded.organizationId,
        to: "deploying",
      }),
    ).rejects.toThrow("Deployment cannot transition from queued to deploying");

    const [deployment] = await client.db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, seeded.deploymentId));
    expect(deployment?.state).toBe("queued");
    await expect(
      client.db
        .select()
        .from(schema.deploymentEvents)
        .where(eq(schema.deploymentEvents.deploymentId, seeded.deploymentId)),
    ).resolves.toHaveLength(0);
  });

  it("does not reveal a deployment through another organization", async () => {
    const seeded = await seedDeployment();

    await expect(
      store.transition({
        deploymentId: seeded.deploymentId,
        idempotencyKey: "cross-tenant",
        organizationId: randomUUID(),
        to: "cloning",
      }),
    ).rejects.toBeInstanceOf(DeploymentNotFoundError);
  });

  it("enforces project ownership in the database", async () => {
    const first = await seedDeployment();
    const second = await seedDeployment();

    await expect(
      client.db.insert(schema.deployments).values({
        configurationSnapshot: {},
        organizationId: first.organizationId,
        projectId: second.projectId,
        sourceRevision: "a".repeat(40),
        sourceSnapshot: {},
      }),
    ).rejects.toThrow(/deployments_project_organization_fk/);
  });

  it("keeps deployment source and configuration snapshots immutable", async () => {
    const seeded = await seedDeployment();

    await expect(
      client.db
        .update(schema.deployments)
        .set({ configurationSnapshot: { changed: true } })
        .where(eq(schema.deployments.id, seeded.deploymentId)),
    ).rejects.toThrow(/deployment source and configuration snapshots are immutable/);
  });

  it("requires recorded health success before promotion", async () => {
    const candidate = await seedDeployment({ state: "health_checking" });

    await expect(
      store.promote({
        deploymentId: candidate.deploymentId,
        idempotencyKey: "premature-promotion",
        organizationId: candidate.organizationId,
      }),
    ).rejects.toBeInstanceOf(DeploymentPersistenceConflictError);

    await expect(client.db.select().from(schema.activeReleases)).resolves.toHaveLength(0);
  });

  it("preserves the active release when a candidate fails", async () => {
    const active = await seedDeployment({ state: "active" });
    const candidate = await seedDeployment({
      organizationId: active.organizationId,
      projectId: active.projectId,
      state: "health_checking",
    });
    await client.db.insert(schema.activeReleases).values({
      deploymentId: active.deploymentId,
      organizationId: active.organizationId,
      projectId: active.projectId,
    });

    await store.transition({
      deploymentId: candidate.deploymentId,
      failure: { category: "health_unhealthy", message: "Health check did not pass" },
      idempotencyKey: "candidate-health-failed",
      organizationId: candidate.organizationId,
      to: "deployment_failed",
    });

    const [release] = await client.db.select().from(schema.activeReleases);
    expect(release?.deploymentId).toBe(active.deploymentId);
  });

  it("does not supersede an active deployment outside promotion", async () => {
    const active = await seedDeployment({ state: "active" });
    await client.db.insert(schema.activeReleases).values({
      deploymentId: active.deploymentId,
      organizationId: active.organizationId,
      projectId: active.projectId,
    });

    await expect(
      store.transition({
        deploymentId: active.deploymentId,
        idempotencyKey: "unsafe-direct-supersede",
        organizationId: active.organizationId,
        to: "superseded",
      }),
    ).rejects.toBeInstanceOf(DeploymentPersistenceConflictError);

    const [deployment] = await client.db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, active.deploymentId));
    const [release] = await client.db.select().from(schema.activeReleases);
    expect(deployment?.state).toBe("active");
    expect(release?.deploymentId).toBe(active.deploymentId);
  });

  it("serializes concurrent promotions to one active release", async () => {
    const first = await seedDeployment({
      healthChecked: true,
      state: "health_checking",
    });
    const second = await seedDeployment({
      healthChecked: true,
      organizationId: first.organizationId,
      projectId: first.projectId,
      state: "health_checking",
    });

    await Promise.all([
      store.promote({
        deploymentId: first.deploymentId,
        idempotencyKey: "promote-first",
        organizationId: first.organizationId,
      }),
      store.promote({
        deploymentId: second.deploymentId,
        idempotencyKey: "promote-second",
        organizationId: second.organizationId,
      }),
    ]);

    const projectDeployments = await client.db
      .select({ id: schema.deployments.id, state: schema.deployments.state })
      .from(schema.deployments)
      .where(eq(schema.deployments.projectId, first.projectId));
    const releases = await client.db
      .select()
      .from(schema.activeReleases)
      .where(eq(schema.activeReleases.projectId, first.projectId));

    expect(projectDeployments.filter(({ state }) => state === "active")).toHaveLength(1);
    expect(projectDeployments.filter(({ state }) => state === "superseded")).toHaveLength(1);
    expect(releases).toHaveLength(1);
    expect(projectDeployments.find(({ state }) => state === "active")?.id).toBe(
      releases[0]?.deploymentId,
    );
  });
});
