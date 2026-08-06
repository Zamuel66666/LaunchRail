import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import type { MembershipRole } from "@launchrail/domain";
import {
  createDatabaseClient,
  PasswordHasher,
  PostgresIdentityStore,
  schema,
} from "@launchrail/database";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { FastifyInstance, InjectOptions } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildServer } from "../src/server.js";

const databaseUrl = process.env.DATABASE_URL;
const describeWithDatabase = databaseUrl === undefined ? describe.skip : describe;
const now = new Date("2026-08-06T08:00:00.000Z");
const password = "correct horse battery staple";
const webOrigin = "http://localhost:3000";
const roles = ["owner", "admin", "developer", "viewer"] as const;

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

describeWithDatabase("authenticated organization API", () => {
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
    absoluteTtlMs: 60 * 60 * 1000,
    idleTtlMs: 15 * 60 * 1000,
    passwordHasher,
  });
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
      { id: organizationId, name: "Acme Platform", slug: `acme-${organizationId.slice(0, 8)}` },
      {
        id: otherOrganizationId,
        name: "Other Platform",
        slug: `other-${otherOrganizationId.slice(0, 8)}`,
      },
    ]);

    const identities = Object.fromEntries(
      roles.map((role) => {
        const id = randomUUID();
        return [role, { email: `${role}@launchrail.test`, id, role }];
      }),
    ) as unknown as Readonly<Record<MembershipRole, SeededIdentity>>;
    const otherUserId = randomUUID();
    const allUsers = [
      ...roles.map((role) => identities[role]),
      { email: "outsider@launchrail.test", id: otherUserId, role: "viewer" as const },
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

  function createServer(options: { secureCookies?: boolean; signInRateLimitMax?: number } = {}) {
    const server = buildServer({
      identityStore,
      now: () => now,
      secureCookies: options.secureCookies ?? false,
      signInRateLimitMax: options.signInRateLimitMax ?? 100,
      webOrigin,
    });
    servers.push(server);
    return server;
  }

  async function signIn(
    server: FastifyInstance,
    role: MembershipRole,
  ): Promise<{
    readonly cookie: string;
    readonly response: Awaited<ReturnType<typeof server.inject>>;
  }> {
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
    return { cookie: setCookie.split(";", 1)[0] ?? "", response };
  }

  function authenticatedRequest(cookie: string, request: InjectOptions): InjectOptions {
    return {
      ...request,
      headers: { ...request.headers, cookie, origin: webOrigin },
    };
  }

  it("stores only a hash of the opaque token and revokes it on sign-out", async () => {
    const server = createServer();
    const { cookie, response } = await signIn(server, "owner");
    const rawToken = cookie.slice(cookie.indexOf("=") + 1);

    expect(response.statusCode).toBe(200);
    expect(response.headers["set-cookie"]).toContain("HttpOnly");
    expect(response.headers["set-cookie"]).toContain("SameSite=Strict");
    expect(response.headers["set-cookie"]).not.toContain("Secure");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");

    const [storedSession] = await client.db.select().from(schema.sessions);
    expect(storedSession?.tokenHash).toBe(createHash("sha256").update(rawToken).digest("hex"));
    expect(storedSession?.tokenHash).not.toContain(rawToken);

    const sessionResponse = await server.inject(
      authenticatedRequest(cookie, { method: "GET", url: "/v1/auth/session" }),
    );
    expect(sessionResponse.statusCode).toBe(200);
    expect(sessionResponse.json().user).toMatchObject({
      email: fixture.identities.owner.email,
      memberships: [{ organizationId: fixture.organizationId, role: "owner" }],
    });

    const signOutResponse = await server.inject(
      authenticatedRequest(cookie, { method: "POST", url: "/v1/auth/sign-out" }),
    );
    expect(signOutResponse.statusCode).toBe(204);
    expect(signOutResponse.headers["set-cookie"]).toContain("Max-Age=0");
    await expect(identityStore.resolveSession(rawToken, now)).resolves.toBeNull();
  });

  it("uses secure cookies when configured for production", async () => {
    const server = createServer({ secureCookies: true });
    const { response } = await signIn(server, "owner");

    expect(response.headers["set-cookie"]).toContain("Secure");
  });

  it("returns one generic response for unknown emails and wrong passwords", async () => {
    const server = createServer();
    const responses = await Promise.all(
      [
        { email: "unknown@launchrail.test", password },
        { email: fixture.identities.owner.email, password: "incorrect password value" },
      ].map(async (payload) =>
        server.inject({
          headers: { origin: webOrigin },
          method: "POST",
          payload,
          url: "/v1/auth/sign-in",
        }),
      ),
    );

    expect(responses.map((response) => response.statusCode)).toEqual([401, 401]);
    expect(responses[0]?.json()).toEqual(responses[1]?.json());
  });

  it("rate-limits repeated sign-in attempts by client", async () => {
    const server = createServer({ signInRateLimitMax: 2 });
    const request = {
      headers: { origin: webOrigin },
      method: "POST" as const,
      payload: { email: "unknown@launchrail.test", password },
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

  it("rejects unauthenticated, malformed, and cross-origin requests", async () => {
    const server = createServer();

    const unauthenticated = await server.inject({
      method: "GET",
      url: `/v1/organizations/${fixture.organizationId}`,
    });
    expect(unauthenticated.statusCode).toBe(401);

    const { cookie } = await signIn(server, "owner");
    const malformed = await server.inject(
      authenticatedRequest(cookie, { method: "GET", url: "/v1/organizations/not-a-uuid" }),
    );
    expect(malformed.statusCode).toBe(400);

    const missingOrigin = await server.inject({
      headers: { cookie },
      method: "PATCH",
      payload: { role: "developer" },
      url: `/v1/organizations/${fixture.organizationId}/members/${fixture.identities.viewer.id}`,
    });
    const wrongOrigin = await server.inject({
      headers: { cookie, origin: "https://attacker.example" },
      method: "PATCH",
      payload: { role: "developer" },
      url: `/v1/organizations/${fixture.organizationId}/members/${fixture.identities.viewer.id}`,
    });
    expect(missingOrigin.statusCode).toBe(403);
    expect(wrongOrigin.statusCode).toBe(403);
  });

  it.each(roles)("enforces the complete organization permission matrix for %s", async (role) => {
    const server = createServer();
    const { cookie } = await signIn(server, role);
    const organizationResponse = await server.inject(
      authenticatedRequest(cookie, {
        method: "GET",
        url: `/v1/organizations/${fixture.organizationId}`,
      }),
    );
    const membersResponse = await server.inject(
      authenticatedRequest(cookie, {
        method: "GET",
        url: `/v1/organizations/${fixture.organizationId}/members`,
      }),
    );
    const auditResponse = await server.inject(
      authenticatedRequest(cookie, {
        method: "GET",
        url: `/v1/organizations/${fixture.organizationId}/audit-events`,
      }),
    );
    const updateResponse = await server.inject(
      authenticatedRequest(cookie, {
        method: "PATCH",
        payload: { role: "developer" },
        url: `/v1/organizations/${fixture.organizationId}/members/${fixture.identities.viewer.id}`,
      }),
    );

    expect(organizationResponse.statusCode).toBe(200);
    expect(membersResponse.statusCode).toBe(role === "owner" || role === "admin" ? 200 : 403);
    expect(auditResponse.statusCode).toBe(role === "owner" || role === "admin" ? 200 : 403);
    expect(updateResponse.statusCode).toBe(role === "owner" || role === "admin" ? 200 : 403);
  });

  it.each(roles)("conceals every cross-organization access path from %s", async (role) => {
    const server = createServer();
    const { cookie } = await signIn(server, role);
    const requests: InjectOptions[] = [
      { method: "GET", url: `/v1/organizations/${fixture.otherOrganizationId}` },
      { method: "GET", url: `/v1/organizations/${fixture.otherOrganizationId}/members` },
      { method: "GET", url: `/v1/organizations/${fixture.otherOrganizationId}/audit-events` },
      {
        method: "PATCH",
        payload: { role: "developer" },
        url: `/v1/organizations/${fixture.otherOrganizationId}/members/${fixture.otherUserId}`,
      },
    ];
    const responses = await Promise.all(
      requests.map(async (request) => server.inject(authenticatedRequest(cookie, request))),
    );

    expect(responses.map((response) => response.statusCode)).toEqual([404, 404, 404, 404]);
  });

  it("protects privileged roles and prevents demoting the final owner", async () => {
    const server = createServer();
    const adminSession = await signIn(server, "admin");
    const ownerSession = await signIn(server, "owner");

    const adminChangesOwner = await server.inject(
      authenticatedRequest(adminSession.cookie, {
        method: "PATCH",
        payload: { role: "viewer" },
        url: `/v1/organizations/${fixture.organizationId}/members/${fixture.identities.owner.id}`,
      }),
    );
    const finalOwnerDemotion = await server.inject(
      authenticatedRequest(ownerSession.cookie, {
        method: "PATCH",
        payload: { role: "admin" },
        url: `/v1/organizations/${fixture.organizationId}/members/${fixture.identities.owner.id}`,
      }),
    );

    expect(adminChangesOwner.statusCode).toBe(409);
    expect(finalOwnerDemotion.statusCode).toBe(409);

    const promotion = await server.inject(
      authenticatedRequest(ownerSession.cookie, {
        method: "PATCH",
        payload: { role: "owner" },
        url: `/v1/organizations/${fixture.organizationId}/members/${fixture.identities.viewer.id}`,
      }),
    );
    const demotion = await server.inject(
      authenticatedRequest(ownerSession.cookie, {
        method: "PATCH",
        payload: { role: "admin" },
        url: `/v1/organizations/${fixture.organizationId}/members/${fixture.identities.owner.id}`,
      }),
    );
    expect(promotion.statusCode).toBe(200);
    expect(demotion.statusCode).toBe(200);

    const roleUpdates = await client.db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.action, "membership.role_update"));
    expect(roleUpdates).toHaveLength(2);
  });

  it("serializes concurrent owner demotions so one owner always remains", async () => {
    await identityStore.updateMembershipRole({
      actorUserId: fixture.identities.owner.id,
      nextRole: "owner",
      organizationId: fixture.organizationId,
      targetUserId: fixture.identities.viewer.id,
    });

    const results = await Promise.allSettled([
      identityStore.updateMembershipRole({
        actorUserId: fixture.identities.owner.id,
        nextRole: "admin",
        organizationId: fixture.organizationId,
        targetUserId: fixture.identities.owner.id,
      }),
      identityStore.updateMembershipRole({
        actorUserId: fixture.identities.viewer.id,
        nextRole: "admin",
        organizationId: fixture.organizationId,
        targetUserId: fixture.identities.viewer.id,
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const owners = await client.db
      .select({ userId: schema.memberships.userId })
      .from(schema.memberships)
      .where(
        sql`${schema.memberships.organizationId} = ${fixture.organizationId} and ${schema.memberships.role} = 'owner'`,
      );
    expect(owners).toHaveLength(1);
  });

  it("serializes first-owner bootstrap so it remains one-time", async () => {
    await client.db.execute(sql`truncate table users, organizations cascade`);
    const first = identityStore.bootstrapOwner(
      {
        displayName: "First Owner",
        email: "first-owner@launchrail.test",
        organizationName: "First Organization",
        organizationSlug: "first-organization",
        password,
      },
      now,
    );
    const second = identityStore.bootstrapOwner(
      {
        displayName: "Second Owner",
        email: "second-owner@launchrail.test",
        organizationName: "Second Organization",
        organizationSlug: "second-organization",
        password,
      },
      now,
    );
    const results = await Promise.allSettled([first, second]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await expect(client.db.select().from(schema.users)).resolves.toHaveLength(1);
    await expect(client.db.select().from(schema.organizations)).resolves.toHaveLength(1);
  });
});
