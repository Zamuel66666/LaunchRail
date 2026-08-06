import type { MembershipRole, OrganizationPermission } from "@launchrail/domain";

export interface PrincipalMembership {
  readonly organizationId: string;
  readonly organizationName: string;
  readonly organizationSlug: string;
  readonly permissions: readonly OrganizationPermission[];
  readonly role: MembershipRole;
}

export interface SessionPrincipal {
  readonly displayName: string;
  readonly email: string;
  readonly memberships: readonly PrincipalMembership[];
  readonly userId: string;
}

export interface CreatedSession {
  readonly expiresAt: Date;
  readonly principal: SessionPrincipal;
  readonly token: string;
}

export interface OrganizationMember {
  readonly displayName: string;
  readonly email: string;
  readonly role: MembershipRole;
  readonly userId: string;
}

export interface OrganizationSummary {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
}

export interface AuditEventSummary {
  readonly action: string;
  readonly actorUserId: string | null;
  readonly createdAt: Date;
  readonly id: string;
  readonly outcome: "succeeded" | "rejected" | "failed";
  readonly targetId: string;
  readonly targetType: string;
}

export interface BootstrapOwnerCommand {
  readonly displayName: string;
  readonly email: string;
  readonly organizationName: string;
  readonly organizationSlug: string;
  readonly password: string;
}

export interface IdentityStore {
  bootstrapOwner(command: BootstrapOwnerCommand, now: Date): Promise<SessionPrincipal>;
  getOrganization(organizationId: string): Promise<OrganizationSummary | null>;
  listAuditEvents(organizationId: string, limit: number): Promise<readonly AuditEventSummary[]>;
  listMembers(organizationId: string): Promise<readonly OrganizationMember[]>;
  resolveSession(token: string, now: Date): Promise<SessionPrincipal | null>;
  revokeSession(token: string, now: Date): Promise<boolean>;
  signIn(email: string, password: string, now: Date): Promise<CreatedSession | null>;
  updateMembershipRole(command: {
    readonly actorUserId: string;
    readonly nextRole: MembershipRole;
    readonly organizationId: string;
    readonly targetUserId: string;
  }): Promise<OrganizationMember>;
}

export class MembershipUpdateConflictError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "MembershipUpdateConflictError";
  }
}
