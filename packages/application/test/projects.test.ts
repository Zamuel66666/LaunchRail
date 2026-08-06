import { describe, expect, it, vi } from "vitest";

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
  type ArchiveProjectCommand,
  type CreateProjectRecordCommand,
  type DeleteProjectEnvironmentVariableRecordCommand,
  type EnvironmentVariableMetadata,
  type GetProjectQuery,
  type ListProjectsQuery,
  type ProjectManagementStore,
  type ProjectSummary,
  type PutProjectEnvironmentVariableRecordCommand,
  type UpdateProjectRecordCommand,
} from "../src/index.js";

const configuration = {
  defaultBranch: "main",
  dockerfilePath: "Dockerfile",
  healthCheckPath: "/health",
  healthCheckPort: 3_000,
  name: "LaunchRail API",
  repositoryUrl: "https://github.com/LaunchRail/Control-Plane",
  runtimeConfig: {
    cpuMillicores: 500,
    memoryMegabytes: 512,
    processLimit: 128,
    readOnlyRootFilesystem: true,
  },
} as const;

const environmentVariable: EnvironmentVariableMetadata = {
  createdAt: new Date("2026-08-06T10:00:00.000Z"),
  id: "variable-1",
  name: "DATABASE_URL",
  updatedAt: new Date("2026-08-06T10:00:00.000Z"),
};

const summary: ProjectSummary = {
  archivedAt: null,
  createdAt: new Date("2026-08-06T10:00:00.000Z"),
  ...configuration,
  environmentVariables: [environmentVariable],
  id: "project-1",
  organizationId: "organization-1",
  repositoryUrl: "https://github.com/launchrail/control-plane",
  updatedAt: new Date("2026-08-06T10:00:00.000Z"),
  version: 1,
};

function createStore() {
  return {
    archiveProject: vi.fn(async (_command: ArchiveProjectCommand) => summary),
    createProject: vi.fn(async (_command: CreateProjectRecordCommand) => summary),
    deleteEnvironmentVariable: vi.fn(
      async (_command: DeleteProjectEnvironmentVariableRecordCommand) => undefined,
    ),
    getProject: vi.fn(async (_query: GetProjectQuery) => summary),
    listProjects: vi.fn(async (_query: ListProjectsQuery) => [summary]),
    putEnvironmentVariable: vi.fn(
      async (_command: PutProjectEnvironmentVariableRecordCommand) => environmentVariable,
    ),
    updateProject: vi.fn(async (_command: UpdateProjectRecordCommand) => summary),
  } satisfies ProjectManagementStore;
}

const baseScope = {
  actorUserId: "user-1",
  organizationId: "organization-1",
} as const;

describe("project application use cases", () => {
  it("delegates tenant-scoped project reads", async () => {
    const store = createStore();
    const list = new ListProjects(store);
    const get = new GetProject(store);

    await expect(list.execute(baseScope)).resolves.toEqual([summary]);
    await expect(get.execute({ ...baseScope, projectId: "project-1" })).resolves.toEqual(summary);
    expect(store.listProjects).toHaveBeenCalledWith(baseScope);
    expect(store.getProject).toHaveBeenCalledWith({ ...baseScope, projectId: "project-1" });
  });

  it("normalizes project input before creating a record", async () => {
    const store = createStore();
    const create = new CreateProject(store);

    await create.execute({
      ...baseScope,
      configuration: {
        ...configuration,
        defaultBranch: "  feature/projects  ",
        name: "  LaunchRail API  ",
      },
    });

    expect(store.createProject).toHaveBeenCalledWith({
      ...baseScope,
      configuration: {
        ...configuration,
        defaultBranch: "feature/projects",
        name: "LaunchRail API",
        repositoryUrl: "https://github.com/launchrail/control-plane",
      },
    });
  });

  it("rejects unsafe project input before invoking persistence", async () => {
    const store = createStore();
    const create = new CreateProject(store);

    expect(() =>
      create.execute({
        ...baseScope,
        configuration: {
          ...configuration,
          repositoryUrl: "file:///private/repository",
        },
      }),
    ).toThrow("Invalid project input: repositoryUrl");
    expect(store.createProject).not.toHaveBeenCalled();
  });

  it("normalizes updates and preserves optimistic-concurrency metadata", async () => {
    const store = createStore();
    const update = new UpdateProject(store);

    await update.execute({
      ...baseScope,
      configuration,
      expectedVersion: 3,
      projectId: "project-1",
    });

    expect(store.updateProject).toHaveBeenCalledWith({
      ...baseScope,
      configuration: {
        ...configuration,
        repositoryUrl: "https://github.com/launchrail/control-plane",
      },
      expectedVersion: 3,
      projectId: "project-1",
    });
  });

  it("forwards an archive command without discarding actor or version", async () => {
    const store = createStore();
    const archive = new ArchiveProject(store);
    const command = {
      ...baseScope,
      expectedVersion: 2,
      projectId: "project-1",
    };

    await expect(archive.execute(command)).resolves.toEqual(summary);
    expect(store.archiveProject).toHaveBeenCalledWith(command);
  });

  it("normalizes secret names while preserving the exact secret value", async () => {
    const store = createStore();
    const put = new PutProjectEnvironmentVariable(store);
    const value = "  postgresql://launchrail.test/database  ";

    await put.execute({
      ...baseScope,
      name: "  DATABASE_URL  ",
      projectId: "project-1",
      value,
    });

    expect(store.putEnvironmentVariable).toHaveBeenCalledWith({
      ...baseScope,
      name: "DATABASE_URL",
      projectId: "project-1",
      value,
    });
  });

  it("rejects a secret containing a null byte before persistence without echoing it", async () => {
    const store = createStore();
    const put = new PutProjectEnvironmentVariable(store);
    const value = "phase-four-canary\0secret";

    try {
      await put.execute({
        ...baseScope,
        name: "DATABASE_URL",
        projectId: "project-1",
        value,
      });
      throw new Error("Expected secret validation to fail");
    } catch (error) {
      expect((error as Error).message).not.toContain("phase-four-canary");
    }
    expect(store.putEnvironmentVariable).not.toHaveBeenCalled();
  });

  it("validates secret names before deletion", async () => {
    const store = createStore();
    const remove = new DeleteProjectEnvironmentVariable(store);

    await remove.execute({
      ...baseScope,
      name: "  DATABASE_URL  ",
      projectId: "project-1",
    });
    expect(store.deleteEnvironmentVariable).toHaveBeenCalledWith({
      ...baseScope,
      name: "DATABASE_URL",
      projectId: "project-1",
    });

    expect(() =>
      remove.execute({ ...baseScope, name: "not-safe", projectId: "project-1" }),
    ).toThrow("Invalid project input: environmentVariableName");
  });

  it("uses stable, non-sensitive persistence errors", () => {
    expect(new ProjectNotFoundError().message).toBe("Project not found");
    expect(new ProjectConflictError("version_mismatch")).toMatchObject({
      code: "version_mismatch",
      message: "Project was changed by another request",
      name: "ProjectConflictError",
    });
  });
});
