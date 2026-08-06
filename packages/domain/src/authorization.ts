export const membershipRoles = ["owner", "admin", "developer", "viewer"] as const;

export type MembershipRole = (typeof membershipRoles)[number];

export const organizationPermissions = [
  "organization:read",
  "organization:manage",
  "project:read",
  "project:create",
  "deployment:create",
  "deployment:control",
  "membership:read",
  "membership:manage",
  "audit:read",
] as const;

export type OrganizationPermission = (typeof organizationPermissions)[number];

const permissionsByRole = {
  admin: new Set<OrganizationPermission>([
    "organization:read",
    "project:read",
    "project:create",
    "deployment:create",
    "deployment:control",
    "membership:read",
    "membership:manage",
    "audit:read",
  ]),
  developer: new Set<OrganizationPermission>([
    "organization:read",
    "project:read",
    "project:create",
    "deployment:create",
    "deployment:control",
  ]),
  owner: new Set<OrganizationPermission>(organizationPermissions),
  viewer: new Set<OrganizationPermission>(["organization:read", "project:read"]),
} satisfies Readonly<Record<MembershipRole, ReadonlySet<OrganizationPermission>>>;

export function hasOrganizationPermission(
  role: MembershipRole,
  permission: OrganizationPermission,
): boolean {
  return permissionsByRole[role].has(permission);
}

export function permissionsForRole(role: MembershipRole): readonly OrganizationPermission[] {
  return organizationPermissions.filter((permission) =>
    hasOrganizationPermission(role, permission),
  );
}

export function canManageMembershipRole(options: {
  readonly actorRole: MembershipRole;
  readonly currentRole: MembershipRole;
  readonly nextRole: MembershipRole;
}): boolean {
  const { actorRole, currentRole, nextRole } = options;

  if (actorRole === "owner") {
    return true;
  }

  return (
    actorRole === "admin" &&
    (currentRole === "developer" || currentRole === "viewer") &&
    (nextRole === "developer" || nextRole === "viewer")
  );
}
