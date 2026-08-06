import { describe, expect, it } from "vitest";

import {
  canManageMembershipRole,
  hasOrganizationPermission,
  membershipRoles,
  organizationPermissions,
  permissionsForRole,
} from "../src/index.js";

const expectedPermissions = {
  admin: [
    "organization:read",
    "project:read",
    "project:create",
    "project:update",
    "project:delete",
    "deployment:create",
    "deployment:control",
    "secret:read-metadata",
    "secret:manage",
    "membership:read",
    "membership:manage",
    "audit:read",
  ],
  developer: [
    "organization:read",
    "project:read",
    "project:create",
    "project:update",
    "deployment:create",
    "deployment:control",
  ],
  owner: organizationPermissions,
  viewer: ["organization:read", "project:read"],
} as const;

describe("organization authorization", () => {
  it.each(membershipRoles)("defines the complete permission set for %s", (role) => {
    expect(permissionsForRole(role)).toEqual(expectedPermissions[role]);

    for (const permission of organizationPermissions) {
      expect(hasOrganizationPermission(role, permission), `${role}: ${permission}`).toBe(
        expectedPermissions[role].includes(permission as never),
      );
    }
  });

  it("allows owners to manage every membership role", () => {
    for (const currentRole of membershipRoles) {
      for (const nextRole of membershipRoles) {
        expect(canManageMembershipRole({ actorRole: "owner", currentRole, nextRole })).toBe(true);
      }
    }
  });

  it("limits administrators to developer and viewer memberships", () => {
    for (const currentRole of membershipRoles) {
      for (const nextRole of membershipRoles) {
        expect(canManageMembershipRole({ actorRole: "admin", currentRole, nextRole })).toBe(
          (currentRole === "developer" || currentRole === "viewer") &&
            (nextRole === "developer" || nextRole === "viewer"),
        );
      }
    }
  });

  it.each(["developer", "viewer"] as const)(
    "does not allow %s to manage memberships",
    (actorRole) => {
      expect(
        canManageMembershipRole({
          actorRole,
          currentRole: "viewer",
          nextRole: "developer",
        }),
      ).toBe(false);
    },
  );
});
