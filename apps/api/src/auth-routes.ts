import {
  MembershipUpdateConflictError,
  type DeploymentJobStore,
  type IdentityStore,
  type ProjectManagementStore,
  type SessionPrincipal,
} from "@launchrail/application";
import {
  hasOrganizationPermission,
  membershipRoles,
  type OrganizationPermission,
} from "@launchrail/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { registerProjectRoutes } from "./project-routes.js";

interface RegisterAuthRoutesOptions {
  readonly cookieName: string;
  readonly identityStore: IdentityStore;
  readonly now: () => Date;
  readonly projectStore?: ProjectManagementStore;
  readonly deploymentStore?: DeploymentJobStore;
  readonly secureCookies: boolean;
  readonly signInRateLimitMax: number;
  readonly webOrigin: string;
}

interface OrganizationParams {
  readonly organizationId: string;
}

interface MembershipParams extends OrganizationParams {
  readonly userId: string;
}

interface SignInBody {
  readonly email: string;
  readonly password: string;
}

interface UpdateMembershipBody {
  readonly role: (typeof membershipRoles)[number];
}

const uuidPattern = "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";

const organizationParamsSchema = {
  additionalProperties: false,
  properties: { organizationId: { pattern: uuidPattern, type: "string" } },
  required: ["organizationId"],
  type: "object",
} as const;

const membershipParamsSchema = {
  additionalProperties: false,
  properties: {
    organizationId: { pattern: uuidPattern, type: "string" },
    userId: { pattern: uuidPattern, type: "string" },
  },
  required: ["organizationId", "userId"],
  type: "object",
} as const;

function errorBody(
  code: string,
  message: string,
): { readonly error: { readonly code: string; readonly message: string } } {
  return { error: { code, message } };
}

function findMembership(
  principal: SessionPrincipal,
  organizationId: string,
): SessionPrincipal["memberships"][number] | undefined {
  return principal.memberships.find((membership) => membership.organizationId === organizationId);
}

export function registerAuthRoutes(
  server: FastifyInstance,
  options: RegisterAuthRoutesOptions,
): void {
  const authenticate = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<SessionPrincipal | null> => {
    const token = request.cookies[options.cookieName];
    if (token === undefined) {
      await reply.code(401).send(errorBody("authentication_required", "Sign in is required"));
      return null;
    }

    const principal = await options.identityStore.resolveSession(token, options.now());
    if (principal === null) {
      reply.clearCookie(options.cookieName, { path: "/" });
      await reply.code(401).send(errorBody("authentication_required", "Sign in is required"));
      return null;
    }

    return principal;
  };

  const authorizeOrganization = async (
    request: FastifyRequest,
    reply: FastifyReply,
    organizationId: string,
    permission: OrganizationPermission,
  ): Promise<{
    readonly membership: SessionPrincipal["memberships"][number];
    readonly principal: SessionPrincipal;
  } | null> => {
    const principal = await authenticate(request, reply);
    if (principal === null) {
      return null;
    }

    const membership = findMembership(principal, organizationId);
    if (membership === undefined) {
      await reply.code(404).send(errorBody("organization_not_found", "Organization not found"));
      return null;
    }
    if (!hasOrganizationPermission(membership.role, permission)) {
      await reply.code(403).send(errorBody("permission_denied", "Permission denied"));
      return null;
    }

    return { membership, principal };
  };

  server.addHook("onRequest", async (request, reply) => {
    if (
      request.url.startsWith("/v1/") &&
      ["DELETE", "PATCH", "POST", "PUT"].includes(request.method) &&
      request.headers.origin !== options.webOrigin
    ) {
      return reply.code(403).send(errorBody("origin_rejected", "Request origin is not allowed"));
    }
  });

  server.post<{ Body: SignInBody }>(
    "/v1/auth/sign-in",
    {
      config: {
        rateLimit: {
          groupId: "sign-in",
          max: options.signInRateLimitMax,
          timeWindow: "1 minute",
        },
      },
      schema: {
        body: {
          additionalProperties: false,
          properties: {
            email: { maxLength: 320, minLength: 3, type: "string" },
            password: { maxLength: 1024, minLength: 12, type: "string" },
          },
          required: ["email", "password"],
          type: "object",
        },
      },
    },
    async (request, reply) => {
      if (Buffer.byteLength(request.body.password, "utf8") > 1024) {
        return reply.code(400).send(errorBody("invalid_request", "Invalid request"));
      }

      const session = await options.identityStore.signIn(
        request.body.email,
        request.body.password,
        options.now(),
      );
      if (session === null) {
        return reply
          .code(401)
          .send(errorBody("invalid_credentials", "Email or password is incorrect"));
      }

      const maxAge = Math.max(
        0,
        Math.floor((session.expiresAt.getTime() - options.now().getTime()) / 1000),
      );
      reply.setCookie(options.cookieName, session.token, {
        httpOnly: true,
        maxAge,
        path: "/",
        sameSite: "strict",
        secure: options.secureCookies,
      });
      return { user: session.principal };
    },
  );

  server.post("/v1/auth/sign-out", async (request, reply) => {
    const token = request.cookies[options.cookieName];
    if (token !== undefined) {
      await options.identityStore.revokeSession(token, options.now());
    }
    reply.clearCookie(options.cookieName, {
      httpOnly: true,
      path: "/",
      sameSite: "strict",
      secure: options.secureCookies,
    });
    return reply.code(204).send();
  });

  server.get("/v1/auth/session", async (request, reply) => {
    const principal = await authenticate(request, reply);
    return principal === null ? undefined : { user: principal };
  });

  server.get("/v1/organizations", async (request, reply) => {
    const principal = await authenticate(request, reply);
    return principal === null ? undefined : { organizations: principal.memberships };
  });

  server.get<{ Params: OrganizationParams }>(
    "/v1/organizations/:organizationId",
    {
      schema: {
        params: organizationParamsSchema,
      },
    },
    async (request, reply) => {
      const authorization = await authorizeOrganization(
        request,
        reply,
        request.params.organizationId,
        "organization:read",
      );
      if (authorization === null) {
        return;
      }
      const organization = await options.identityStore.getOrganization(
        request.params.organizationId,
      );
      return organization === null
        ? reply.code(404).send(errorBody("organization_not_found", "Organization not found"))
        : { membership: authorization.membership, organization };
    },
  );

  server.get<{ Params: OrganizationParams }>(
    "/v1/organizations/:organizationId/members",
    { schema: { params: organizationParamsSchema } },
    async (request, reply) => {
      const authorization = await authorizeOrganization(
        request,
        reply,
        request.params.organizationId,
        "membership:read",
      );
      return authorization === null
        ? undefined
        : { members: await options.identityStore.listMembers(request.params.organizationId) };
    },
  );

  server.patch<{ Body: UpdateMembershipBody; Params: MembershipParams }>(
    "/v1/organizations/:organizationId/members/:userId",
    {
      schema: {
        body: {
          additionalProperties: false,
          properties: { role: { enum: membershipRoles, type: "string" } },
          required: ["role"],
          type: "object",
        },
        params: membershipParamsSchema,
      },
    },
    async (request, reply) => {
      const authorization = await authorizeOrganization(
        request,
        reply,
        request.params.organizationId,
        "membership:manage",
      );
      if (authorization === null) {
        return;
      }

      try {
        return {
          member: await options.identityStore.updateMembershipRole({
            actorUserId: authorization.principal.userId,
            nextRole: request.body.role,
            organizationId: request.params.organizationId,
            targetUserId: request.params.userId,
          }),
        };
      } catch (error) {
        if (!(error instanceof MembershipUpdateConflictError)) {
          throw error;
        }
        request.log.info(
          { error, organizationId: request.params.organizationId },
          "Membership update rejected",
        );
        return reply
          .code(409)
          .send(errorBody("membership_conflict", "Membership role could not be changed"));
      }
    },
  );

  server.get<{ Params: OrganizationParams }>(
    "/v1/organizations/:organizationId/audit-events",
    { schema: { params: organizationParamsSchema } },
    async (request, reply) => {
      const authorization = await authorizeOrganization(
        request,
        reply,
        request.params.organizationId,
        "audit:read",
      );
      return authorization === null
        ? undefined
        : {
            events: await options.identityStore.listAuditEvents(request.params.organizationId, 100),
          };
    },
  );

  if (options.projectStore !== undefined) {
    registerProjectRoutes(server, {
      authorizeOrganization,
      projectStore: options.projectStore,
    });
  }

  if (options.deploymentStore !== undefined) {
    server.get<{
      Params: { organizationId: string; deploymentId: string };
      Querystring: { limit?: string };
    }>(
      "/v1/organizations/:organizationId/deployments/:deploymentId/health-checks",
      {
        schema: {
          params: {
            additionalProperties: false,
            properties: {
              deploymentId: { pattern: uuidPattern, type: "string" },
              organizationId: { pattern: uuidPattern, type: "string" },
            },
            required: ["organizationId", "deploymentId"],
            type: "object",
          },
          querystring: {
            additionalProperties: false,
            properties: { limit: { pattern: "^[0-9]{1,3}$", type: "string" } },
            type: "object",
          },
        },
      },
      async (request, reply) => {
        const authorization = await authorizeOrganization(
          request,
          reply,
          request.params.organizationId,
          "project:read",
        );
        if (authorization === null) return;
        const limit = request.query.limit === undefined ? 50 : Number(request.query.limit);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
          return reply.code(400).send(errorBody("invalid_request", "Invalid history limit"));
        const checks = await options.deploymentStore?.listHealthChecks?.({
          deploymentId: request.params.deploymentId,
          organizationId: request.params.organizationId,
          limit,
        });
        return { checks: checks ?? [] };
      },
    );
  }
}
