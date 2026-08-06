import type {
  ArchiveProjectCommand,
  CreateProjectRecordCommand,
  DeleteProjectEnvironmentVariableRecordCommand,
  EnvironmentVariableMetadata,
  GetProjectQuery,
  IdentityStore,
  ListProjectsQuery,
  ProjectManagementStore,
  ProjectSummary,
  PutProjectEnvironmentVariableRecordCommand,
  UpdateProjectRecordCommand,
} from "@launchrail/application";
import { permissionsForRole, type MembershipRole } from "@launchrail/domain";
import { afterEach, describe, expect, it } from "vitest";

import { buildServer } from "../src/server.js";

const organizationId = "e79877d7-0c5b-4169-87ee-bf1d77701a46";
const projectId = "ab45096e-d02a-401e-a98d-7dde508e4c53";
const userId = "3630f591-81b7-4470-882a-249d612eb24b";
const webOrigin = "http://localhost:3000";
const now = new Date("2026-08-06T09:00:00.000Z");
const variable = {
  createdAt: now,
  id: "cb8099b7-948d-4f76-86e4-87c976927060",
  name: "DATABASE_URL",
  updatedAt: now,
} satisfies EnvironmentVariableMetadata;
const summary = {
  archivedAt: null,
  createdAt: now,
  defaultBranch: "main",
  dockerfilePath: "deploy/Dockerfile",
  environmentVariables: [variable],
  healthCheckPath: "/health",
  healthCheckPort: 3_000,
  id: projectId,
  name: "LaunchRail API",
  organizationId,
  repositoryUrl: "https://github.com/openai/launchrail",
  runtimeConfig: {
    cpuMillicores: 500,
    memoryMegabytes: 512,
    processLimit: 128,
    readOnlyRootFilesystem: true,
  },
  updatedAt: now,
  version: 1,
} satisfies ProjectSummary;

class FakeProjectStore implements ProjectManagementStore {
  public readonly created: CreateProjectRecordCommand[] = [];
  public readonly secrets: PutProjectEnvironmentVariableRecordCommand[] = [];

  public async archiveProject(_command: ArchiveProjectCommand): Promise<ProjectSummary> {
    return { ...summary, archivedAt: now, version: 2 };
  }

  public async createProject(command: CreateProjectRecordCommand): Promise<ProjectSummary> {
    this.created.push(command);
    return { ...summary, ...command.configuration, environmentVariables: [] };
  }

  public async deleteEnvironmentVariable(
    _command: DeleteProjectEnvironmentVariableRecordCommand,
  ): Promise<void> {}

  public async getProject(_query: GetProjectQuery): Promise<ProjectSummary> {
    return summary;
  }

  public async listProjects(_query: ListProjectsQuery): Promise<readonly ProjectSummary[]> {
    return [summary];
  }

  public async putEnvironmentVariable(
    command: PutProjectEnvironmentVariableRecordCommand,
  ): Promise<EnvironmentVariableMetadata> {
    this.secrets.push(command);
    return variable;
  }

  public async updateProject(_command: UpdateProjectRecordCommand): Promise<ProjectSummary> {
    return { ...summary, version: 2 };
  }
}

function identityStoreFor(role: MembershipRole): IdentityStore {
  return {
    async bootstrapOwner() {
      throw new Error("not used");
    },
    async getOrganization() {
      return { id: organizationId, name: "LaunchRail", slug: "launchrail" };
    },
    async listAuditEvents() {
      return [];
    },
    async listMembers() {
      return [];
    },
    async resolveSession() {
      return {
        displayName: "Project tester",
        email: "projects@launchrail.test",
        memberships: [
          {
            organizationId,
            organizationName: "LaunchRail",
            organizationSlug: "launchrail",
            permissions: permissionsForRole(role),
            role,
          },
        ],
        userId,
      };
    },
    async revokeSession() {
      return true;
    },
    async signIn() {
      return null;
    },
    async updateMembershipRole() {
      throw new Error("not used");
    },
  };
}

const servers: ReturnType<typeof buildServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => server.close()));
});

function createServer(role: MembershipRole, projectStore = new FakeProjectStore()) {
  const server = buildServer({
    identityStore: identityStoreFor(role),
    projectStore,
    webOrigin,
  });
  servers.push(server);
  return { projectStore, server };
}

function headers(origin = webOrigin): Readonly<Record<string, string>> {
  return { cookie: "launchrail_session=test", origin };
}

const projectInput = {
  defaultBranch: "main",
  dockerfilePath: "deploy/Dockerfile",
  healthCheckPath: "/health",
  healthCheckPort: 3_000,
  name: "LaunchRail API",
  repositoryUrl: "https://github.com/OpenAI/LaunchRail",
  runtimeConfig: {
    cpuMillicores: 500,
    memoryMegabytes: 512,
    processLimit: 128,
    readOnlyRootFilesystem: true,
  },
};

describe("project API contract", () => {
  it("normalizes project input and returns metadata without an archived field", async () => {
    const { projectStore, server } = createServer("owner");
    const response = await server.inject({
      headers: headers(),
      method: "POST",
      payload: projectInput,
      url: `/v1/organizations/${organizationId}/projects`,
    });

    expect(response.statusCode).toBe(201);
    expect(projectStore.created[0]?.configuration.repositoryUrl).toBe(
      "https://github.com/openai/launchrail",
    );
    expect(response.json().project).not.toHaveProperty("archivedAt");
    expect(response.json().project.environmentVariables).toEqual([]);
  });

  it("rejects unsafe configuration and cross-origin writes before the store", async () => {
    const { projectStore, server } = createServer("owner");
    const unsafe = await server.inject({
      headers: headers(),
      method: "POST",
      payload: { ...projectInput, repositoryUrl: "https://github.com/openai/../../etc" },
      url: `/v1/organizations/${organizationId}/projects`,
    });
    const unsupportedRuntimeCapability = await server.inject({
      headers: headers(),
      method: "POST",
      payload: {
        ...projectInput,
        runtimeConfig: { ...projectInput.runtimeConfig, privileged: true },
      },
      url: `/v1/organizations/${organizationId}/projects`,
    });
    const crossOrigin = await server.inject({
      headers: headers("https://attacker.example"),
      method: "POST",
      payload: projectInput,
      url: `/v1/organizations/${organizationId}/projects`,
    });

    expect(unsafe.statusCode).toBe(400);
    expect(unsafe.json().error).toMatchObject({ code: "invalid_project_configuration" });
    expect(unsupportedRuntimeCapability.statusCode).toBe(400);
    expect(unsupportedRuntimeCapability.json().error).toMatchObject({ code: "invalid_request" });
    expect(crossOrigin.statusCode).toBe(403);
    expect(projectStore.created).toHaveLength(0);
  });

  it("returns write-only secret metadata and never echoes the submitted value", async () => {
    const { projectStore, server } = createServer("owner");
    const canary = "phase-four-super-secret-canary";
    const response = await server.inject({
      headers: headers(),
      method: "PUT",
      payload: { value: canary },
      url: `/v1/organizations/${organizationId}/projects/${projectId}/environment-variables/DATABASE_URL`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(canary);
    expect(response.json()).toEqual({
      environmentVariable: {
        createdAt: now.toISOString(),
        id: variable.id,
        name: variable.name,
        updatedAt: now.toISOString(),
      },
    });
    expect(projectStore.secrets[0]?.value).toBe(canary);
  });

  it.each(["developer", "viewer"] as const)(
    "hides secret metadata and management from the %s role",
    async (role) => {
      const { server } = createServer(role);
      const list = await server.inject({
        headers: headers(),
        method: "GET",
        url: `/v1/organizations/${organizationId}/projects`,
      });
      const put = await server.inject({
        headers: headers(),
        method: "PUT",
        payload: { value: "not-stored" },
        url: `/v1/organizations/${organizationId}/projects/${projectId}/environment-variables/DATABASE_URL`,
      });

      expect(list.statusCode).toBe(200);
      expect(list.json().projects[0].environmentVariables).toEqual([]);
      expect(put.statusCode).toBe(403);
    },
  );
});
