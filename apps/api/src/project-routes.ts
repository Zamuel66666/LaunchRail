import {
  ArchiveProject,
  CreateProject,
  DeleteProjectEnvironmentVariable,
  GetProject,
  ListProjects,
  ProjectConflictError,
  ProjectNotFoundError,
  PutProjectEnvironmentVariable,
  UpdateProject,
  type ProjectManagementStore,
  type ProjectSummary,
  type SessionPrincipal,
} from "@launchrail/application";
import {
  hasOrganizationPermission,
  ProjectValidationError,
  type OrganizationPermission,
  type ProjectConfigurationInput,
} from "@launchrail/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

interface OrganizationParams {
  readonly organizationId: string;
}

interface ProjectParams extends OrganizationParams {
  readonly projectId: string;
}

interface EnvironmentVariableParams extends ProjectParams {
  readonly name: string;
}

interface UpdateProjectBody extends ProjectConfigurationInput {
  readonly expectedVersion: number;
}

interface VersionBody {
  readonly expectedVersion: number;
}

interface SecretBody {
  readonly value: string;
}

export interface OrganizationAuthorization {
  readonly membership: SessionPrincipal["memberships"][number];
  readonly principal: SessionPrincipal;
}

export type AuthorizeOrganization = (
  request: FastifyRequest,
  reply: FastifyReply,
  organizationId: string,
  permission: OrganizationPermission,
) => Promise<OrganizationAuthorization | null>;

interface RegisterProjectRoutesOptions {
  readonly authorizeOrganization: AuthorizeOrganization;
  readonly projectStore: ProjectManagementStore;
}

const uuidPattern = "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";

const organizationParamsSchema = {
  additionalProperties: false,
  properties: { organizationId: { pattern: uuidPattern, type: "string" } },
  required: ["organizationId"],
  type: "object",
} as const;

const projectParamsSchema = {
  additionalProperties: false,
  properties: {
    organizationId: { pattern: uuidPattern, type: "string" },
    projectId: { pattern: uuidPattern, type: "string" },
  },
  required: ["organizationId", "projectId"],
  type: "object",
} as const;

const environmentVariableParamsSchema = {
  additionalProperties: false,
  properties: {
    name: { maxLength: 128, pattern: "^[A-Z_][A-Z0-9_]*$", type: "string" },
    organizationId: { pattern: uuidPattern, type: "string" },
    projectId: { pattern: uuidPattern, type: "string" },
  },
  required: ["organizationId", "projectId", "name"],
  type: "object",
} as const;

const runtimeConfigSchema = {
  additionalProperties: false,
  properties: {
    cpuMillicores: { maximum: 4_000, minimum: 100, type: "integer" },
    memoryMegabytes: { maximum: 8_192, minimum: 64, type: "integer" },
    processLimit: { maximum: 1_024, minimum: 16, type: "integer" },
    readOnlyRootFilesystem: { type: "boolean" },
  },
  required: ["cpuMillicores", "memoryMegabytes", "processLimit", "readOnlyRootFilesystem"],
  type: "object",
} as const;

const projectProperties = {
  defaultBranch: { maxLength: 255, minLength: 1, type: "string" },
  dockerfilePath: { maxLength: 256, minLength: 1, type: "string" },
  healthCheckPath: { maxLength: 256, minLength: 1, type: "string" },
  healthCheckPort: { maximum: 65_535, minimum: 1, type: "integer" },
  name: { maxLength: 80, minLength: 1, type: "string" },
  repositoryUrl: { maxLength: 230, minLength: 20, type: "string" },
  runtimeConfig: runtimeConfigSchema,
} as const;

const projectRequired = [
  "defaultBranch",
  "dockerfilePath",
  "healthCheckPath",
  "healthCheckPort",
  "name",
  "repositoryUrl",
  "runtimeConfig",
] as const;

const createProjectBodySchema = {
  additionalProperties: false,
  properties: projectProperties,
  required: projectRequired,
  type: "object",
} as const;

const updateProjectBodySchema = {
  additionalProperties: false,
  properties: {
    ...projectProperties,
    expectedVersion: { maximum: 2_147_483_647, minimum: 1, type: "integer" },
  },
  required: [...projectRequired, "expectedVersion"],
  type: "object",
} as const;

const versionBodySchema = {
  additionalProperties: false,
  properties: {
    expectedVersion: { maximum: 2_147_483_647, minimum: 1, type: "integer" },
  },
  required: ["expectedVersion"],
  type: "object",
} as const;

function serializedProject(project: ProjectSummary, includeSecretMetadata: boolean) {
  return {
    createdAt: project.createdAt.toISOString(),
    defaultBranch: project.defaultBranch,
    dockerfilePath: project.dockerfilePath,
    environmentVariables: includeSecretMetadata
      ? project.environmentVariables.map((variable) => ({
          createdAt: variable.createdAt.toISOString(),
          id: variable.id,
          name: variable.name,
          updatedAt: variable.updatedAt.toISOString(),
        }))
      : [],
    healthCheckPath: project.healthCheckPath,
    healthCheckPort: project.healthCheckPort,
    id: project.id,
    name: project.name,
    organizationId: project.organizationId,
    repositoryUrl: project.repositoryUrl,
    runtimeConfig: project.runtimeConfig,
    updatedAt: project.updatedAt.toISOString(),
    version: project.version,
  };
}

function includeSecretMetadata(authorization: OrganizationAuthorization): boolean {
  return hasOrganizationPermission(authorization.membership.role, "secret:read-metadata");
}

function sendProjectError(error: unknown, reply: FastifyReply): boolean {
  if (error instanceof ProjectValidationError) {
    void reply.code(400).send({
      error: {
        code: "invalid_project_configuration",
        fields: error.issues.map((issue) => ({ code: issue.code, field: issue.field })),
        message: "Project configuration is invalid",
      },
    });
    return true;
  }
  if (error instanceof ProjectNotFoundError) {
    void reply.code(404).send({
      error: { code: "project_not_found", message: "Project not found" },
    });
    return true;
  }
  if (error instanceof ProjectConflictError) {
    void reply.code(409).send({ error: { code: error.code, message: error.message } });
    return true;
  }
  return false;
}

export function registerProjectRoutes(
  server: FastifyInstance,
  options: RegisterProjectRoutesOptions,
): void {
  const listProjects = new ListProjects(options.projectStore);
  const getProject = new GetProject(options.projectStore);
  const createProject = new CreateProject(options.projectStore);
  const updateProject = new UpdateProject(options.projectStore);
  const archiveProject = new ArchiveProject(options.projectStore);
  const putEnvironmentVariable = new PutProjectEnvironmentVariable(options.projectStore);
  const deleteEnvironmentVariable = new DeleteProjectEnvironmentVariable(options.projectStore);

  server.get<{ Params: OrganizationParams }>(
    "/v1/organizations/:organizationId/projects",
    { schema: { params: organizationParamsSchema } },
    async (request, reply) => {
      const authorization = await options.authorizeOrganization(
        request,
        reply,
        request.params.organizationId,
        "project:read",
      );
      if (authorization === null) return;
      const projects = await listProjects.execute({
        actorUserId: authorization.principal.userId,
        organizationId: request.params.organizationId,
      });
      return {
        projects: projects.map((project) =>
          serializedProject(project, includeSecretMetadata(authorization)),
        ),
      };
    },
  );

  server.get<{ Params: ProjectParams }>(
    "/v1/organizations/:organizationId/projects/:projectId",
    { schema: { params: projectParamsSchema } },
    async (request, reply) => {
      const authorization = await options.authorizeOrganization(
        request,
        reply,
        request.params.organizationId,
        "project:read",
      );
      if (authorization === null) return;
      try {
        const project = await getProject.execute({
          actorUserId: authorization.principal.userId,
          organizationId: request.params.organizationId,
          projectId: request.params.projectId,
        });
        return { project: serializedProject(project, includeSecretMetadata(authorization)) };
      } catch (error) {
        if (sendProjectError(error, reply)) return;
        throw error;
      }
    },
  );

  server.post<{ Body: ProjectConfigurationInput; Params: OrganizationParams }>(
    "/v1/organizations/:organizationId/projects",
    { schema: { body: createProjectBodySchema, params: organizationParamsSchema } },
    async (request, reply) => {
      const authorization = await options.authorizeOrganization(
        request,
        reply,
        request.params.organizationId,
        "project:create",
      );
      if (authorization === null) return;
      try {
        const project = await createProject.execute({
          actorUserId: authorization.principal.userId,
          configuration: request.body,
          organizationId: request.params.organizationId,
        });
        return reply.code(201).send({ project: serializedProject(project, false) });
      } catch (error) {
        if (sendProjectError(error, reply)) return;
        throw error;
      }
    },
  );

  server.patch<{ Body: UpdateProjectBody; Params: ProjectParams }>(
    "/v1/organizations/:organizationId/projects/:projectId",
    { schema: { body: updateProjectBodySchema, params: projectParamsSchema } },
    async (request, reply) => {
      const authorization = await options.authorizeOrganization(
        request,
        reply,
        request.params.organizationId,
        "project:update",
      );
      if (authorization === null) return;
      const { expectedVersion, ...configuration } = request.body;
      try {
        const project = await updateProject.execute({
          actorUserId: authorization.principal.userId,
          configuration,
          expectedVersion,
          organizationId: request.params.organizationId,
          projectId: request.params.projectId,
        });
        return { project: serializedProject(project, includeSecretMetadata(authorization)) };
      } catch (error) {
        if (sendProjectError(error, reply)) return;
        throw error;
      }
    },
  );

  server.delete<{ Body: VersionBody; Params: ProjectParams }>(
    "/v1/organizations/:organizationId/projects/:projectId",
    { schema: { body: versionBodySchema, params: projectParamsSchema } },
    async (request, reply) => {
      const authorization = await options.authorizeOrganization(
        request,
        reply,
        request.params.organizationId,
        "project:delete",
      );
      if (authorization === null) return;
      try {
        await archiveProject.execute({
          actorUserId: authorization.principal.userId,
          expectedVersion: request.body.expectedVersion,
          organizationId: request.params.organizationId,
          projectId: request.params.projectId,
        });
        return reply.code(204).send();
      } catch (error) {
        if (sendProjectError(error, reply)) return;
        throw error;
      }
    },
  );

  server.put<{ Body: SecretBody; Params: EnvironmentVariableParams }>(
    "/v1/organizations/:organizationId/projects/:projectId/environment-variables/:name",
    {
      schema: {
        body: {
          additionalProperties: false,
          properties: { value: { maxLength: 16_384, minLength: 1, type: "string" } },
          required: ["value"],
          type: "object",
        },
        params: environmentVariableParamsSchema,
      },
    },
    async (request, reply) => {
      const authorization = await options.authorizeOrganization(
        request,
        reply,
        request.params.organizationId,
        "secret:manage",
      );
      if (authorization === null) return;
      try {
        const variable = await putEnvironmentVariable.execute({
          actorUserId: authorization.principal.userId,
          name: request.params.name,
          organizationId: request.params.organizationId,
          projectId: request.params.projectId,
          value: request.body.value,
        });
        return {
          environmentVariable: {
            createdAt: variable.createdAt.toISOString(),
            id: variable.id,
            name: variable.name,
            updatedAt: variable.updatedAt.toISOString(),
          },
        };
      } catch (error) {
        if (sendProjectError(error, reply)) return;
        throw error;
      }
    },
  );

  server.delete<{ Params: EnvironmentVariableParams }>(
    "/v1/organizations/:organizationId/projects/:projectId/environment-variables/:name",
    { schema: { params: environmentVariableParamsSchema } },
    async (request, reply) => {
      const authorization = await options.authorizeOrganization(
        request,
        reply,
        request.params.organizationId,
        "secret:manage",
      );
      if (authorization === null) return;
      try {
        await deleteEnvironmentVariable.execute({
          actorUserId: authorization.principal.userId,
          name: request.params.name,
          organizationId: request.params.organizationId,
          projectId: request.params.projectId,
        });
        return reply.code(204).send();
      } catch (error) {
        if (sendProjectError(error, reply)) return;
        throw error;
      }
    },
  );
}
