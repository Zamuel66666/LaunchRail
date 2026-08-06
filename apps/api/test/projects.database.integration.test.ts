import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import type { MembershipRole, ProjectConfigurationInput } from "@launchrail/domain";
import {
  AesGcmSecretCipher,
  createDatabaseClient,
  PasswordHasher,
  PostgresIdentityStore,
  PostgresProjectManagementStore,
  schema,
} from "@launchrail/database";
import { asc, eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { FastifyInstance, InjectOptions } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildServer } from "../src/server.js";

const databaseUrl = process.env.DATABASE_URL;
const describeWithDatabase = databaseUrl === undefined ? describe.skip : describe;
const now = new Date("2026-08-06T10:00:00.000Z");
const password = "correct horse battery staple";
const webOrigin = "http://localhost:3000";
const roles = ["owner", "admin", "developer", "viewer"] as const;

const runtimeConfig = {
  cpuMillicores: 500,
  memoryMegabytes: 512,
  processLimit: 128,
  readOnlyRootFilesystem: true,
} as const;

interface SeededIdentity {
  readonly email: string;
  readonly id: string;
  readonly role: MembershipRole;
}

interface SeededFixture {
  readonly identities: Readonly<Record<MembershipRole, SeededIdentity>>;
  readonly organizationId: string;
  readonly otherOrganizationId: string;
  readonly otherUserId: string;
}

function validConfiguration(label: string): ProjectConfigurationInput {
  const repository = label.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-");
  return {
    defaultBranch: "main",
    dockerfilePath: "deploy/Dockerfile",
    healthCheckPath: "/health/ready",
    healthCheckPort: 3_000,
    name: `${label} service`,
    repositoryUrl: `https://github.com/launchrail/${repository}`,
    runtimeConfig,
  };
}

describeWithDatabase("project management API backed by PostgreSQL", () => {
  if (databaseUrl === undefined) {
    return;
  }

  const client = createDatabaseClient(databaseUrl);
  const passwordHasher = new PasswordHasher({
    blockSize: 8,
    cost: 1_024,
    keyLength: 32,
    parallelization: 1,
    saltLength: 16,
  });
  const identityStore = new PostgresIdentityStore(client.db, {
    absoluteTtlMs: 60 * 60 * 1_000,
    idleTtlMs: 15 * 60 * 1_000,
    passwordHasher,
  });
  const secretCipher = new AesGcmSecretCipher(new Map([[7, new Uint8Array(32).fill(0x5a)]]), 7);
  const projectStore = new PostgresProjectManagementStore(client.db, secretCipher);
  const servers: FastifyInstance[] = [];
  let fixture: SeededFixture;

  beforeAll(async () => {
    await migrate(client.db, {
      migrationsFolder: fileURLToPath(
        new URL("../../../packages/database/drizzle", import.meta.url),
      ),
    });
  });

  beforeEach(async () => {
    await client.db.execute(sql`truncate table users, organizations cascade`);
    fixture = await seedFixture();
  });

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(async (server) => server.close()));
  });

  afterAll(async () => {
    await client.close();
  });

  async function seedFixture(): Promise<SeededFixture> {
    const organizationId = randomUUID();
    const otherOrganizationId = randomUUID();
    await client.db.insert(schema.organizations).values([
      {
        id: organizationId,
        name: "Acme Platform",
        slug: `acme-${organizationId.slice(0, 8)}`,
      },
      {
        id: otherOrganizationId,
        name: "Other Platform",
        slug: `other-${otherOrganizationId.slice(0, 8)}`,
      },
    ]);

    const identities = Object.fromEntries(
      roles.map((role) => {
        const id = randomUUID();
        return [role, { email: `${role}@projects.launchrail.test`, id, role }];
      }),
    ) as unknown as Readonly<Record<MembershipRole, SeededIdentity>>;
    const otherUserId = randomUUID();
    const allUsers = [
      ...roles.map((role) => identities[role]),
      {
        email: "outsider@projects.launchrail.test",
        id: otherUserId,
        role: "viewer" as const,
      },
    ];

    await client.db.insert(schema.users).values(
      allUsers.map((identity) => ({
        displayName: `${identity.role} user`,
        email: identity.email,
        id: identity.id,
      })),
    );
    const passwordHash = await passwordHasher.hash(password);
    await client.db
      .insert(schema.passwordCredentials)
      .values(allUsers.map((identity) => ({ passwordHash, userId: identity.id })));
    await client.db.insert(schema.memberships).values([
      ...roles.map((role) => ({
        organizationId,
        role,
        userId: identities[role].id,
      })),
      { organizationId: otherOrganizationId, role: "viewer", userId: otherUserId },
    ]);

    return { identities, organizationId, otherOrganizationId, otherUserId };
  }

  function createServer(): FastifyInstance {
    const server = buildServer({
      identityStore,
      now: () => now,
      projectStore,
      secureCookies: false,
      signInRateLimitMax: 100,
      webOrigin,
    });
    servers.push(server);
    return server;
  }

  async function signIn(server: FastifyInstance, role: MembershipRole): Promise<string> {
    const response = await server.inject({
      headers: { origin: webOrigin },
      method: "POST",
      payload: { email: fixture.identities[role].email, password },
      url: "/v1/auth/sign-in",
    });
    const setCookie = response.headers["set-cookie"];
    if (typeof setCookie !== "string") {
      throw new Error(`Sign-in did not return a session cookie: ${response.body}`);
    }
    return setCookie.split(";", 1)[0] ?? "";
  }

  function authenticatedRequest(cookie: string, request: InjectOptions): InjectOptions {
    return {
      ...request,
      headers: { ...request.headers, cookie, origin: webOrigin },
    };
  }

  async function seedProject(organizationId: string, label: string): Promise<string> {
    const configuration = validConfiguration(label);
    const repositoryName = configuration.repositoryUrl.split("/").at(-1);
    if (repositoryName === undefined || repositoryName.length === 0) {
      throw new Error("Project seed repository URL did not contain a repository name");
    }
    const [project] = await client.db
      .insert(schema.projects)
      .values({
        defaultBranch: configuration.defaultBranch,
        dockerfilePath: configuration.dockerfilePath,
        healthCheckPath: configuration.healthCheckPath,
        healthCheckPort: configuration.healthCheckPort,
        name: configuration.name,
        organizationId,
        repositoryName,
        repositoryOwner: "launchrail",
        runtimeConfig: configuration.runtimeConfig,
      })
      .returning({ id: schema.projects.id });
    if (project === undefined) {
      throw new Error("Project seed did not return a record");
    }
    return project.id;
  }

  it("persists an optimistic owner lifecycle, encrypted metadata, audit evidence, and a soft archive", async () => {
    const server = createServer();
    const ownerCookie = await signIn(server, "owner");
    const responseBodies: string[] = [];

    const createResponse = await server.inject(
      authenticatedRequest(ownerCookie, {
        method: "POST",
        payload: validConfiguration("Payments API"),
        url: `/v1/organizations/${fixture.organizationId}/projects`,
      }),
    );
    responseBodies.push(createResponse.body);
    expect(createResponse.statusCode).toBe(201);
    expect(createResponse.json().project).toMatchObject({
      environmentVariables: [],
      name: "Payments API service",
      organizationId: fixture.organizationId,
      repositoryUrl: "https://github.com/launchrail/payments-api",
      runtimeConfig,
      version: 1,
    });
    const projectId = createResponse.json().project.id as string;

    const getResponse = await server.inject(
      authenticatedRequest(ownerCookie, {
        method: "GET",
        url: `/v1/organizations/${fixture.organizationId}/projects/${projectId}`,
      }),
    );
    const listResponse = await server.inject(
      authenticatedRequest(ownerCookie, {
        method: "GET",
        url: `/v1/organizations/${fixture.organizationId}/projects`,
      }),
    );
    responseBodies.push(getResponse.body, listResponse.body);
    expect(getResponse.statusCode).toBe(200);
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json().projects).toHaveLength(1);

    const duplicateName = await server.inject(
      authenticatedRequest(ownerCookie, {
        method: "POST",
        payload: {
          ...validConfiguration("Payments API"),
          repositoryUrl: "https://github.com/launchrail/another-payments-repository",
        },
        url: `/v1/organizations/${fixture.organizationId}/projects`,
      }),
    );
    responseBodies.push(duplicateName.body);
    expect(duplicateName.statusCode).toBe(409);
    expect(duplicateName.json()).toEqual({
      error: {
        code: "name_taken",
        message: "A project with this name already exists",
      },
    });

    const updatedConfiguration = {
      ...validConfiguration("Payments API"),
      defaultBranch: "release/phase-4",
      healthCheckPath: "/internal/ready",
      name: "Payments production",
    };
    const updateResponse = await server.inject(
      authenticatedRequest(ownerCookie, {
        method: "PATCH",
        payload: { ...updatedConfiguration, expectedVersion: 1 },
        url: `/v1/organizations/${fixture.organizationId}/projects/${projectId}`,
      }),
    );
    responseBodies.push(updateResponse.body);
    expect(updateResponse.statusCode).toBe(200);
    expect(updateResponse.json().project).toMatchObject({
      defaultBranch: "release/phase-4",
      healthCheckPath: "/internal/ready",
      name: "Payments production",
      version: 2,
    });

    const staleUpdate = await server.inject(
      authenticatedRequest(ownerCookie, {
        method: "PATCH",
        payload: { ...updatedConfiguration, expectedVersion: 1 },
        url: `/v1/organizations/${fixture.organizationId}/projects/${projectId}`,
      }),
    );
    responseBodies.push(staleUpdate.body);
    expect(staleUpdate.statusCode).toBe(409);
    expect(staleUpdate.json()).toEqual({
      error: {
        code: "version_mismatch",
        message: "Project was changed by another request",
      },
    });

    const plaintext = "postgresql://app:do-not-leak@database.internal/launchrail";
    const putSecretResponse = await server.inject(
      authenticatedRequest(ownerCookie, {
        method: "PUT",
        payload: { value: plaintext },
        url: `/v1/organizations/${fixture.organizationId}/projects/${projectId}/environment-variables/DATABASE_URL`,
      }),
    );
    responseBodies.push(putSecretResponse.body);
    expect(putSecretResponse.statusCode).toBe(200);
    expect(Object.keys(putSecretResponse.json().environmentVariable).sort()).toEqual([
      "createdAt",
      "id",
      "name",
      "updatedAt",
    ]);

    const [storedSecret] = await client.db
      .select()
      .from(schema.environmentVariables)
      .where(eq(schema.environmentVariables.projectId, projectId));
    expect(storedSecret).toMatchObject({
      algorithm: "aes-256-gcm",
      keyVersion: 7,
      name: "DATABASE_URL",
      organizationId: fixture.organizationId,
      projectId,
    });
    expect(storedSecret?.encryptedValue).not.toBe(plaintext);
    expect(storedSecret?.encryptedValue).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(storedSecret?.nonce).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(storedSecret?.authTag).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(JSON.stringify(storedSecret)).not.toContain(plaintext);

    const ownerProjectResponse = await server.inject(
      authenticatedRequest(ownerCookie, {
        method: "GET",
        url: `/v1/organizations/${fixture.organizationId}/projects/${projectId}`,
      }),
    );
    responseBodies.push(ownerProjectResponse.body);
    expect(ownerProjectResponse.json().project.environmentVariables).toEqual([
      expect.objectContaining({ name: "DATABASE_URL" }),
    ]);
    expect(Object.keys(ownerProjectResponse.json().project.environmentVariables[0]).sort()).toEqual(
      ["createdAt", "id", "name", "updatedAt"],
    );

    for (const role of ["developer", "viewer"] as const) {
      const cookie = await signIn(server, role);
      const concealed = await server.inject(
        authenticatedRequest(cookie, {
          method: "GET",
          url: `/v1/organizations/${fixture.organizationId}/projects/${projectId}`,
        }),
      );
      responseBodies.push(concealed.body);
      expect(concealed.statusCode).toBe(200);
      expect(concealed.json().project.environmentVariables).toEqual([]);
    }

    const deploymentId = randomUUID();
    await client.db.insert(schema.deployments).values({
      configurationSnapshot: { projectVersion: 2 },
      finishedAt: now,
      id: deploymentId,
      organizationId: fixture.organizationId,
      projectId,
      sourceRevision: "a".repeat(40),
      sourceSnapshot: { branch: "release/phase-4" },
      state: "stopped",
    });

    const archiveResponse = await server.inject(
      authenticatedRequest(ownerCookie, {
        method: "DELETE",
        payload: { expectedVersion: 2 },
        url: `/v1/organizations/${fixture.organizationId}/projects/${projectId}`,
      }),
    );
    responseBodies.push(archiveResponse.body);
    expect(archiveResponse.statusCode).toBe(204);

    const archivedGet = await server.inject(
      authenticatedRequest(ownerCookie, {
        method: "GET",
        url: `/v1/organizations/${fixture.organizationId}/projects/${projectId}`,
      }),
    );
    const archivedList = await server.inject(
      authenticatedRequest(ownerCookie, {
        method: "GET",
        url: `/v1/organizations/${fixture.organizationId}/projects`,
      }),
    );
    expect(archivedGet.statusCode).toBe(404);
    expect(archivedList.json().projects).toEqual([]);

    const [archivedProject] = await client.db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, projectId));
    expect(archivedProject?.archivedAt).toBeInstanceOf(Date);
    expect(archivedProject?.version).toBe(3);
    await expect(
      client.db
        .select()
        .from(schema.environmentVariables)
        .where(eq(schema.environmentVariables.projectId, projectId)),
    ).resolves.toHaveLength(0);
    await expect(
      client.db.select().from(schema.deployments).where(eq(schema.deployments.id, deploymentId)),
    ).resolves.toHaveLength(1);

    const audits = await client.db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.targetId, projectId))
      .orderBy(asc(schema.auditEvents.createdAt));
    expect(audits).toHaveLength(4);
    expect(audits.map((event) => event.action)).toEqual(
      expect.arrayContaining([
        "project.create",
        "project.update",
        "project.environment_variable.put",
        "project.archive",
      ]),
    );
    expect(audits.every((event) => event.actorUserId === fixture.identities.owner.id)).toBe(true);
    expect(audits.find((event) => event.action === "project.update")?.metadata).toEqual({
      changedFields: ["name", "defaultBranch", "healthCheckPath"],
    });
    expect(audits.find((event) => event.action === "project.archive")?.metadata).toEqual({
      deletedEnvironmentVariableCount: 1,
    });
    expect(JSON.stringify(audits)).not.toContain(plaintext);
    expect(responseBodies.join("\n")).not.toContain(plaintext);
  });

  it("rejects unsafe repository, path, runtime, and environment-variable input", async () => {
    const server = createServer();
    const ownerCookie = await signIn(server, "owner");
    const projectId = await seedProject(fixture.organizationId, "Validation");
    const base = validConfiguration("Invalid candidate");
    const invalidConfigurations = [
      { ...base, repositoryUrl: "https://github.com/acme/repository.git" },
      { ...base, repositoryUrl: "https://github.com/acme/repository/../../escape" },
      { ...base, defaultBranch: "refs/heads/../../escape" },
      { ...base, dockerfilePath: "../Dockerfile" },
      { ...base, healthCheckPath: "//attacker.example/ready" },
      { ...base, healthCheckPath: "/ready?token=secret" },
      { ...base, runtimeConfig: { ...runtimeConfig, cpuMillicores: 99 } },
      { ...base, runtimeConfig: { ...runtimeConfig, privileged: true } },
    ];

    for (const payload of invalidConfigurations) {
      const response = await server.inject(
        authenticatedRequest(ownerCookie, {
          method: "POST",
          payload,
          url: `/v1/organizations/${fixture.organizationId}/projects`,
        }),
      );
      expect(response.statusCode).toBe(400);
    }

    const invalidName = await server.inject(
      authenticatedRequest(ownerCookie, {
        method: "PUT",
        payload: { value: "safe-value" },
        url: `/v1/organizations/${fixture.organizationId}/projects/${projectId}/environment-variables/lowercase`,
      }),
    );
    const nullByteValue = await server.inject(
      authenticatedRequest(ownerCookie, {
        method: "PUT",
        payload: { value: "unsafe\0value" },
        url: `/v1/organizations/${fixture.organizationId}/projects/${projectId}/environment-variables/API_TOKEN`,
      }),
    );
    const oversizedUtf8Value = await server.inject(
      authenticatedRequest(ownerCookie, {
        method: "PUT",
        payload: { value: "é".repeat(9_000) },
        url: `/v1/organizations/${fixture.organizationId}/projects/${projectId}/environment-variables/API_TOKEN`,
      }),
    );

    expect(invalidName.statusCode).toBe(400);
    expect(nullByteValue.statusCode).toBe(400);
    expect(oversizedUtf8Value.statusCode).toBe(400);
    await expect(client.db.select().from(schema.projects)).resolves.toHaveLength(1);
    await expect(client.db.select().from(schema.environmentVariables)).resolves.toHaveLength(0);
  });

  it("rejects archiving projects with an in-flight deployment or active release", async () => {
    const server = createServer();
    const ownerCookie = await signIn(server, "owner");
    const inFlightProjectId = await seedProject(fixture.organizationId, "In flight");
    const activeProjectId = await seedProject(fixture.organizationId, "Active release");
    const inFlightDeploymentId = randomUUID();
    const activeDeploymentId = randomUUID();

    await client.db.insert(schema.deployments).values([
      {
        configurationSnapshot: { projectVersion: 1 },
        id: inFlightDeploymentId,
        organizationId: fixture.organizationId,
        projectId: inFlightProjectId,
        sourceRevision: "b".repeat(40),
        sourceSnapshot: { branch: "main" },
        state: "cloning",
      },
      {
        configurationSnapshot: { projectVersion: 1 },
        healthCheckedAt: now,
        id: activeDeploymentId,
        organizationId: fixture.organizationId,
        projectId: activeProjectId,
        sourceRevision: "c".repeat(40),
        sourceSnapshot: { branch: "main" },
        state: "active",
      },
    ]);
    await client.db.insert(schema.activeReleases).values({
      deploymentId: activeDeploymentId,
      organizationId: fixture.organizationId,
      projectId: activeProjectId,
    });

    for (const projectId of [inFlightProjectId, activeProjectId]) {
      const response = await server.inject(
        authenticatedRequest(ownerCookie, {
          method: "DELETE",
          payload: { expectedVersion: 1 },
          url: `/v1/organizations/${fixture.organizationId}/projects/${projectId}`,
        }),
      );
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        error: {
          code: "project_in_use",
          message: "Project cannot be archived while it is in use",
        },
      });
    }

    const protectedProjects = await client.db.select().from(schema.projects);
    expect(protectedProjects).toHaveLength(2);
    expect(protectedProjects.every((project) => project.archivedAt === null)).toBe(true);
    await expect(
      client.db
        .select()
        .from(schema.auditEvents)
        .where(eq(schema.auditEvents.action, "project.archive")),
    ).resolves.toHaveLength(0);
  });

  it.each(roles)("enforces the complete project permission matrix for %s", async (role) => {
    const server = createServer();
    const cookie = await signIn(server, role);
    const projectId = await seedProject(fixture.organizationId, `Matrix ${role}`);
    const baseUrl = `/v1/organizations/${fixture.organizationId}/projects`;
    const canConfigure = role !== "viewer";
    const canManageSecretsAndArchive = role === "owner" || role === "admin";

    const listResponse = await server.inject(
      authenticatedRequest(cookie, { method: "GET", url: baseUrl }),
    );
    const getResponse = await server.inject(
      authenticatedRequest(cookie, { method: "GET", url: `${baseUrl}/${projectId}` }),
    );
    const createResponse = await server.inject(
      authenticatedRequest(cookie, {
        method: "POST",
        payload: validConfiguration(`Created by ${role}`),
        url: baseUrl,
      }),
    );
    expect(listResponse.statusCode).toBe(200);
    expect(getResponse.statusCode).toBe(200);
    expect(createResponse.statusCode).toBe(canConfigure ? 201 : 403);

    const updateResponse = await server.inject(
      authenticatedRequest(cookie, {
        method: "PATCH",
        payload: {
          ...validConfiguration(`Updated by ${role}`),
          expectedVersion: 1,
        },
        url: `${baseUrl}/${projectId}`,
      }),
    );
    expect(updateResponse.statusCode).toBe(canConfigure ? 200 : 403);

    const putSecretResponse = await server.inject(
      authenticatedRequest(cookie, {
        method: "PUT",
        payload: { value: `secret-for-${role}` },
        url: `${baseUrl}/${projectId}/environment-variables/API_TOKEN`,
      }),
    );
    expect(putSecretResponse.statusCode).toBe(canManageSecretsAndArchive ? 200 : 403);

    const visibleProject = await server.inject(
      authenticatedRequest(cookie, { method: "GET", url: `${baseUrl}/${projectId}` }),
    );
    expect(visibleProject.statusCode).toBe(200);
    expect(visibleProject.json().project.environmentVariables).toHaveLength(
      canManageSecretsAndArchive ? 1 : 0,
    );

    const deleteSecretResponse = await server.inject(
      authenticatedRequest(cookie, {
        method: "DELETE",
        url: `${baseUrl}/${projectId}/environment-variables/API_TOKEN`,
      }),
    );
    expect(deleteSecretResponse.statusCode).toBe(canManageSecretsAndArchive ? 204 : 403);

    const archiveResponse = await server.inject(
      authenticatedRequest(cookie, {
        method: "DELETE",
        payload: { expectedVersion: canConfigure ? 2 : 1 },
        url: `${baseUrl}/${projectId}`,
      }),
    );
    expect(archiveResponse.statusCode).toBe(canManageSecretsAndArchive ? 204 : 403);
  });

  it.each(roles)(
    "returns 404 for every cross-organization project path used by %s",
    async (role) => {
      const server = createServer();
      const cookie = await signIn(server, role);
      const projectId = await seedProject(fixture.otherOrganizationId, `Other ${role}`);
      const baseUrl = `/v1/organizations/${fixture.otherOrganizationId}/projects`;
      const requests: InjectOptions[] = [
        { method: "GET", url: baseUrl },
        { method: "POST", payload: validConfiguration(`Cross ${role}`), url: baseUrl },
        { method: "GET", url: `${baseUrl}/${projectId}` },
        {
          method: "PATCH",
          payload: { ...validConfiguration(`Cross update ${role}`), expectedVersion: 1 },
          url: `${baseUrl}/${projectId}`,
        },
        {
          method: "DELETE",
          payload: { expectedVersion: 1 },
          url: `${baseUrl}/${projectId}`,
        },
        {
          method: "PUT",
          payload: { value: "cross-organization-secret" },
          url: `${baseUrl}/${projectId}/environment-variables/API_TOKEN`,
        },
        {
          method: "DELETE",
          url: `${baseUrl}/${projectId}/environment-variables/API_TOKEN`,
        },
      ];

      const responses = await Promise.all(
        requests.map(async (request) => server.inject(authenticatedRequest(cookie, request))),
      );
      expect(responses.map((response) => response.statusCode)).toEqual([
        404, 404, 404, 404, 404, 404, 404,
      ]);
    },
  );
});
