import { createHash, randomBytes } from "node:crypto";

import {
  MembershipUpdateConflictError,
  type AuditEventSummary,
  type BootstrapOwnerCommand,
  type CreatedSession,
  type IdentityStore,
  type OrganizationMember,
  type OrganizationSummary,
  type PrincipalMembership,
  type SessionPrincipal,
} from "@launchrail/application";
import {
  canManageMembershipRole,
  permissionsForRole,
  type MembershipRole,
} from "@launchrail/domain";
import { and, desc, eq, isNull, sql } from "drizzle-orm";

import type { LaunchRailDatabase } from "./client.js";
import { PasswordHasher } from "./passwords.js";
import {
  auditEvents,
  memberships,
  organizations,
  passwordCredentials,
  sessions,
  users,
} from "./schema.js";

interface IdentityStoreOptions {
  readonly absoluteTtlMs?: number;
  readonly idleTtlMs?: number;
  readonly passwordHasher?: PasswordHasher;
}

interface MembershipRow {
  readonly organizationId: string;
  readonly organizationName: string;
  readonly organizationSlug: string;
  readonly role: MembershipRole;
}

const defaultAbsoluteTtlMs = 24 * 60 * 60 * 1000;
const defaultIdleTtlMs = 30 * 60 * 1000;

function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function toMembership(row: MembershipRow): PrincipalMembership {
  return {
    organizationId: row.organizationId,
    organizationName: row.organizationName,
    organizationSlug: row.organizationSlug,
    permissions: permissionsForRole(row.role),
    role: row.role,
  };
}

function toPrincipal(
  user: { readonly displayName: string; readonly email: string; readonly id: string },
  membershipRows: readonly MembershipRow[],
): SessionPrincipal {
  return {
    displayName: user.displayName,
    email: user.email,
    memberships: membershipRows.map(toMembership),
    userId: user.id,
  };
}

export class PostgresIdentityStore implements IdentityStore {
  private readonly absoluteTtlMs: number;
  private readonly idleTtlMs: number;
  private readonly passwordHasher: PasswordHasher;

  public constructor(
    private readonly db: LaunchRailDatabase,
    options: IdentityStoreOptions = {},
  ) {
    this.absoluteTtlMs = options.absoluteTtlMs ?? defaultAbsoluteTtlMs;
    this.idleTtlMs = options.idleTtlMs ?? defaultIdleTtlMs;
    this.passwordHasher = options.passwordHasher ?? new PasswordHasher();

    if (this.idleTtlMs <= 0 || this.absoluteTtlMs <= 0) {
      throw new Error("Session lifetimes must be positive");
    }
    if (this.idleTtlMs > this.absoluteTtlMs) {
      throw new Error("Session idle lifetime cannot exceed absolute lifetime");
    }
  }

  public async bootstrapOwner(
    command: BootstrapOwnerCommand,
    now: Date,
  ): Promise<SessionPrincipal> {
    const passwordHash = await this.passwordHasher.hash(command.password);

    return this.db.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtext('launchrail_identity_bootstrap'))`,
      );
      const [existingUser] = await transaction.select({ id: users.id }).from(users).limit(1);
      const [existingOrganization] = await transaction
        .select({ id: organizations.id })
        .from(organizations)
        .limit(1);

      if (existingUser !== undefined || existingOrganization !== undefined) {
        throw new MembershipUpdateConflictError(
          "Bootstrap is available only before identity data exists",
        );
      }

      const [user] = await transaction
        .insert(users)
        .values({
          createdAt: now,
          displayName: command.displayName.trim(),
          email: command.email.trim().toLowerCase(),
          updatedAt: now,
        })
        .returning({ displayName: users.displayName, email: users.email, id: users.id });
      const [organization] = await transaction
        .insert(organizations)
        .values({
          createdAt: now,
          name: command.organizationName.trim(),
          slug: command.organizationSlug.trim().toLowerCase(),
          updatedAt: now,
        })
        .returning({ id: organizations.id, name: organizations.name, slug: organizations.slug });

      if (user === undefined || organization === undefined) {
        throw new Error("Bootstrap inserts did not return identity records");
      }

      await transaction.insert(passwordCredentials).values({
        createdAt: now,
        passwordHash,
        updatedAt: now,
        userId: user.id,
      });
      await transaction.insert(memberships).values({
        createdAt: now,
        organizationId: organization.id,
        role: "owner",
        userId: user.id,
      });
      await transaction.insert(auditEvents).values({
        action: "identity.bootstrap",
        actorUserId: user.id,
        createdAt: now,
        metadata: {},
        organizationId: organization.id,
        outcome: "succeeded",
        targetId: organization.id,
        targetType: "organization",
      });

      return toPrincipal(user, [
        {
          organizationId: organization.id,
          organizationName: organization.name,
          organizationSlug: organization.slug,
          role: "owner",
        },
      ]);
    });
  }

  public async signIn(email: string, password: string, now: Date): Promise<CreatedSession | null> {
    const normalizedEmail = email.trim().toLowerCase();
    const [credential] = await this.db
      .select({
        disabledAt: users.disabledAt,
        displayName: users.displayName,
        email: users.email,
        id: users.id,
        passwordHash: passwordCredentials.passwordHash,
      })
      .from(users)
      .innerJoin(passwordCredentials, eq(passwordCredentials.userId, users.id))
      .where(sql`lower(${users.email}) = ${normalizedEmail}`)
      .limit(1);

    if (credential === undefined) {
      await this.passwordHasher.hash(password);
      return null;
    }

    const passwordMatches = await this.passwordHasher.verify(password, credential.passwordHash);
    if (!passwordMatches || credential.disabledAt !== null) {
      await this.recordSignInAudit(credential.id, now, "rejected");
      return null;
    }

    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(now.getTime() + this.absoluteTtlMs);
    const idleExpiresAt = new Date(now.getTime() + this.idleTtlMs);

    return this.db.transaction(async (transaction) => {
      const membershipRows = await transaction
        .select({
          organizationId: organizations.id,
          organizationName: organizations.name,
          organizationSlug: organizations.slug,
          role: memberships.role,
        })
        .from(memberships)
        .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
        .where(eq(memberships.userId, credential.id));

      await transaction.insert(sessions).values({
        createdAt: now,
        expiresAt,
        idleExpiresAt,
        lastSeenAt: now,
        tokenHash: hashSessionToken(token),
        userId: credential.id,
      });

      if (membershipRows.length > 0) {
        await transaction.insert(auditEvents).values(
          membershipRows.map((membership) => ({
            action: "auth.sign_in",
            actorUserId: credential.id,
            createdAt: now,
            metadata: {},
            organizationId: membership.organizationId,
            outcome: "succeeded" as const,
            targetId: credential.id,
            targetType: "user",
          })),
        );
      }

      return {
        expiresAt,
        principal: toPrincipal(credential, membershipRows),
        token,
      };
    });
  }

  public async resolveSession(token: string, now: Date): Promise<SessionPrincipal | null> {
    const tokenHash = hashSessionToken(token);

    return this.db.transaction(async (transaction) => {
      const [session] = await transaction
        .select({
          displayName: users.displayName,
          disabledAt: users.disabledAt,
          email: users.email,
          expiresAt: sessions.expiresAt,
          idleExpiresAt: sessions.idleExpiresAt,
          revokedAt: sessions.revokedAt,
          sessionId: sessions.id,
          userId: users.id,
        })
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .where(eq(sessions.tokenHash, tokenHash))
        .for("update");

      if (session === undefined) {
        return null;
      }

      if (
        session.revokedAt !== null ||
        session.disabledAt !== null ||
        session.expiresAt <= now ||
        session.idleExpiresAt <= now
      ) {
        if (session.revokedAt === null) {
          await transaction
            .update(sessions)
            .set({ revokedAt: now })
            .where(eq(sessions.id, session.sessionId));
        }
        return null;
      }

      const membershipRows = await transaction
        .select({
          organizationId: organizations.id,
          organizationName: organizations.name,
          organizationSlug: organizations.slug,
          role: memberships.role,
        })
        .from(memberships)
        .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
        .where(eq(memberships.userId, session.userId));
      const nextIdleExpiry = new Date(
        Math.min(session.expiresAt.getTime(), now.getTime() + this.idleTtlMs),
      );

      await transaction
        .update(sessions)
        .set({ idleExpiresAt: nextIdleExpiry, lastSeenAt: now })
        .where(eq(sessions.id, session.sessionId));

      return toPrincipal(
        { displayName: session.displayName, email: session.email, id: session.userId },
        membershipRows,
      );
    });
  }

  public async revokeSession(token: string, now: Date): Promise<boolean> {
    const tokenHash = hashSessionToken(token);

    return this.db.transaction(async (transaction) => {
      const [session] = await transaction
        .select({ id: sessions.id, userId: sessions.userId })
        .from(sessions)
        .where(and(eq(sessions.tokenHash, tokenHash), isNull(sessions.revokedAt)))
        .for("update");

      if (session === undefined) {
        return false;
      }

      await transaction.update(sessions).set({ revokedAt: now }).where(eq(sessions.id, session.id));

      const organizationRows = await transaction
        .select({ organizationId: memberships.organizationId })
        .from(memberships)
        .where(eq(memberships.userId, session.userId));
      if (organizationRows.length > 0) {
        await transaction.insert(auditEvents).values(
          organizationRows.map(({ organizationId }) => ({
            action: "auth.sign_out",
            actorUserId: session.userId,
            createdAt: now,
            metadata: {},
            organizationId,
            outcome: "succeeded" as const,
            targetId: session.userId,
            targetType: "user",
          })),
        );
      }

      return true;
    });
  }

  public async getOrganization(organizationId: string): Promise<OrganizationSummary | null> {
    const [organization] = await this.db
      .select({ id: organizations.id, name: organizations.name, slug: organizations.slug })
      .from(organizations)
      .where(eq(organizations.id, organizationId));
    return organization ?? null;
  }

  public listMembers(organizationId: string): Promise<readonly OrganizationMember[]> {
    return this.db
      .select({
        displayName: users.displayName,
        email: users.email,
        role: memberships.role,
        userId: users.id,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.organizationId, organizationId));
  }

  public listAuditEvents(
    organizationId: string,
    limit: number,
  ): Promise<readonly AuditEventSummary[]> {
    return this.db
      .select({
        action: auditEvents.action,
        actorUserId: auditEvents.actorUserId,
        createdAt: auditEvents.createdAt,
        id: auditEvents.id,
        outcome: auditEvents.outcome,
        targetId: auditEvents.targetId,
        targetType: auditEvents.targetType,
      })
      .from(auditEvents)
      .where(eq(auditEvents.organizationId, organizationId))
      .orderBy(desc(auditEvents.createdAt))
      .limit(limit);
  }

  public async updateMembershipRole(command: {
    readonly actorUserId: string;
    readonly nextRole: MembershipRole;
    readonly organizationId: string;
    readonly targetUserId: string;
  }): Promise<OrganizationMember> {
    return this.db.transaction(async (transaction) => {
      const [organization] = await transaction
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, command.organizationId))
        .for("update");
      if (organization === undefined) {
        throw new MembershipUpdateConflictError("Organization no longer exists");
      }

      const [actor] = await transaction
        .select({ role: memberships.role })
        .from(memberships)
        .where(
          and(
            eq(memberships.organizationId, command.organizationId),
            eq(memberships.userId, command.actorUserId),
          ),
        )
        .for("update");
      const [target] = await transaction
        .select({
          displayName: users.displayName,
          email: users.email,
          role: memberships.role,
          userId: users.id,
        })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(
          and(
            eq(memberships.organizationId, command.organizationId),
            eq(memberships.userId, command.targetUserId),
          ),
        )
        .for("update");

      if (actor === undefined || target === undefined) {
        throw new MembershipUpdateConflictError("Membership no longer exists");
      }
      if (
        !canManageMembershipRole({
          actorRole: actor.role,
          currentRole: target.role,
          nextRole: command.nextRole,
        })
      ) {
        throw new MembershipUpdateConflictError("Membership role change is not allowed");
      }

      if (target.role === "owner" && command.nextRole !== "owner") {
        const ownerRows = await transaction
          .select({ userId: memberships.userId })
          .from(memberships)
          .where(
            and(
              eq(memberships.organizationId, command.organizationId),
              eq(memberships.role, "owner"),
            ),
          )
          .for("update");
        if (ownerRows.length <= 1) {
          throw new MembershipUpdateConflictError("The last owner cannot be demoted");
        }
      }

      await transaction
        .update(memberships)
        .set({ role: command.nextRole })
        .where(
          and(
            eq(memberships.organizationId, command.organizationId),
            eq(memberships.userId, command.targetUserId),
          ),
        );
      await transaction.insert(auditEvents).values({
        action: "membership.role_update",
        actorUserId: command.actorUserId,
        metadata: { from: target.role, to: command.nextRole },
        organizationId: command.organizationId,
        outcome: "succeeded",
        targetId: command.targetUserId,
        targetType: "user",
      });

      return { ...target, role: command.nextRole };
    });
  }

  private async recordSignInAudit(
    userId: string,
    now: Date,
    outcome: "rejected" | "failed",
  ): Promise<void> {
    const organizationRows = await this.db
      .select({ organizationId: memberships.organizationId })
      .from(memberships)
      .where(eq(memberships.userId, userId));
    if (organizationRows.length === 0) {
      return;
    }

    await this.db.insert(auditEvents).values(
      organizationRows.map(({ organizationId }) => ({
        action: "auth.sign_in",
        actorUserId: userId,
        createdAt: now,
        metadata: {},
        organizationId,
        outcome,
        targetId: userId,
        targetType: "user",
      })),
    );
  }
}
