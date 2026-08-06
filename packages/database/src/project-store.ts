import {
  ProjectConflictError,
  ProjectNotFoundError,
  type ArchiveProjectCommand,
  type CreateProjectRecordCommand,
  type DeleteProjectEnvironmentVariableRecordCommand,
  type EnvironmentVariableMetadata,
  type GetProjectQuery,
  type ListProjectsQuery,
  type ProjectManagementStore,
  type ProjectSummary,
  type PutProjectEnvironmentVariableRecordCommand,
  type SecretCipher,
  type UpdateProjectRecordCommand,
} from "@launchrail/application";
import type { DeploymentState, ProjectRuntimeConfig } from "@launchrail/domain";
import { and, asc, desc, eq, inArray, isNull, notInArray } from "drizzle-orm";

import type { LaunchRailDatabase } from "./client.js";
import {
  activeReleases,
  auditEvents,
  deployments,
  environmentVariables,
  projects,
} from "./schema.js";

type ProjectRow = typeof projects.$inferSelect;

const inactiveDeploymentStates: DeploymentState[] = [
  "build_failed",
  "cancelled",
  "deployment_failed",
  "rolled_back",
  "stopped",
];

function repositoryParts(repositoryUrl: string): {
  readonly repositoryName: string;
  readonly repositoryOwner: string;
} {
  const parsed = new URL(repositoryUrl);
  const [repositoryOwner, repositoryName] = parsed.pathname.slice(1).split("/");
  if (repositoryOwner === undefined || repositoryName === undefined) {
    throw new Error("Normalized repository URL does not contain an owner and repository");
  }
  return { repositoryName, repositoryOwner };
}

function repositoryUrl(row: ProjectRow): string {
  return `https://github.com/${row.repositoryOwner}/${row.repositoryName}`;
}

function runtimeConfigurationsMatch(
  existing: ProjectRuntimeConfig,
  next: ProjectRuntimeConfig,
): boolean {
  return (
    existing.cpuMillicores === next.cpuMillicores &&
    existing.memoryMegabytes === next.memoryMegabytes &&
    existing.processLimit === next.processLimit &&
    existing.readOnlyRootFilesystem === next.readOnlyRootFilesystem
  );
}

function toEnvironmentVariableMetadata(
  row: typeof environmentVariables.$inferSelect,
): EnvironmentVariableMetadata {
  return {
    createdAt: row.createdAt,
    id: row.id,
    name: row.name,
    updatedAt: row.updatedAt,
  };
}

function toProjectSummary(
  row: ProjectRow,
  variables: readonly EnvironmentVariableMetadata[],
): ProjectSummary {
  return {
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    defaultBranch: row.defaultBranch,
    dockerfilePath: row.dockerfilePath,
    environmentVariables: variables,
    healthCheckPath: row.healthCheckPath,
    healthCheckPort: row.healthCheckPort,
    id: row.id,
    name: row.name,
    organizationId: row.organizationId,
    repositoryUrl: repositoryUrl(row),
    runtimeConfig: row.runtimeConfig,
    updatedAt: row.updatedAt,
    version: row.version,
  };
}

function changedConfigurationFields(
  existing: ProjectRow,
  command: UpdateProjectRecordCommand,
): readonly string[] {
  const { configuration } = command;
  const nextRepository = repositoryParts(configuration.repositoryUrl);
  const fields: string[] = [];
  if (existing.name !== configuration.name) fields.push("name");
  if (
    existing.repositoryOwner !== nextRepository.repositoryOwner ||
    existing.repositoryName !== nextRepository.repositoryName
  ) {
    fields.push("repositoryUrl");
  }
  if (existing.defaultBranch !== configuration.defaultBranch) fields.push("defaultBranch");
  if (existing.dockerfilePath !== configuration.dockerfilePath) fields.push("dockerfilePath");
  if (existing.healthCheckPath !== configuration.healthCheckPath) fields.push("healthCheckPath");
  if (existing.healthCheckPort !== configuration.healthCheckPort) fields.push("healthCheckPort");
  if (!runtimeConfigurationsMatch(existing.runtimeConfig, configuration.runtimeConfig)) {
    fields.push("runtimeConfig");
  }
  return fields;
}

function isNameConflict(error: unknown): boolean {
  let candidate: unknown = error;
  for (
    let depth = 0;
    depth < 4 && candidate !== null && typeof candidate === "object";
    depth += 1
  ) {
    if (
      "code" in candidate &&
      candidate.code === "23505" &&
      "constraint" in candidate &&
      candidate.constraint === "projects_active_name_lower_unique"
    ) {
      return true;
    }
    candidate = "cause" in candidate ? candidate.cause : null;
  }
  return false;
}

async function withNameConflict<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isNameConflict(error)) {
      throw new ProjectConflictError("name_taken");
    }
    throw error;
  }
}

export class PostgresProjectManagementStore implements ProjectManagementStore {
  public constructor(
    private readonly db: LaunchRailDatabase,
    private readonly secretCipher: SecretCipher,
  ) {}

  public async listProjects(query: ListProjectsQuery): Promise<readonly ProjectSummary[]> {
    const projectRows = await this.db
      .select()
      .from(projects)
      .where(and(eq(projects.organizationId, query.organizationId), isNull(projects.archivedAt)))
      .orderBy(desc(projects.createdAt), asc(projects.name));
    if (projectRows.length === 0) {
      return [];
    }

    const variableRows = await this.db
      .select()
      .from(environmentVariables)
      .where(
        and(
          eq(environmentVariables.organizationId, query.organizationId),
          inArray(
            environmentVariables.projectId,
            projectRows.map((project) => project.id),
          ),
        ),
      )
      .orderBy(asc(environmentVariables.name));
    const variablesByProject = new Map<string, EnvironmentVariableMetadata[]>();
    for (const variable of variableRows) {
      const variables = variablesByProject.get(variable.projectId) ?? [];
      variables.push(toEnvironmentVariableMetadata(variable));
      variablesByProject.set(variable.projectId, variables);
    }

    return projectRows.map((project) =>
      toProjectSummary(project, variablesByProject.get(project.id) ?? []),
    );
  }

  public async getProject(query: GetProjectQuery): Promise<ProjectSummary> {
    const [project] = await this.db
      .select()
      .from(projects)
      .where(
        and(
          eq(projects.id, query.projectId),
          eq(projects.organizationId, query.organizationId),
          isNull(projects.archivedAt),
        ),
      )
      .limit(1);
    if (project === undefined) {
      throw new ProjectNotFoundError();
    }

    const variables = await this.db
      .select()
      .from(environmentVariables)
      .where(
        and(
          eq(environmentVariables.projectId, project.id),
          eq(environmentVariables.organizationId, query.organizationId),
        ),
      )
      .orderBy(asc(environmentVariables.name));
    return toProjectSummary(project, variables.map(toEnvironmentVariableMetadata));
  }

  public async createProject(command: CreateProjectRecordCommand): Promise<ProjectSummary> {
    const repository = repositoryParts(command.configuration.repositoryUrl);

    return withNameConflict(() =>
      this.db.transaction(async (transaction) => {
        const now = new Date();
        const [project] = await transaction
          .insert(projects)
          .values({
            createdAt: now,
            defaultBranch: command.configuration.defaultBranch,
            dockerfilePath: command.configuration.dockerfilePath,
            healthCheckPath: command.configuration.healthCheckPath,
            healthCheckPort: command.configuration.healthCheckPort,
            name: command.configuration.name,
            organizationId: command.organizationId,
            repositoryName: repository.repositoryName,
            repositoryOwner: repository.repositoryOwner,
            runtimeConfig: command.configuration.runtimeConfig,
            updatedAt: now,
          })
          .returning();
        if (project === undefined) {
          throw new Error("Project insert did not return a record");
        }

        await transaction.insert(auditEvents).values({
          action: "project.create",
          actorUserId: command.actorUserId,
          createdAt: now,
          metadata: {},
          organizationId: command.organizationId,
          outcome: "succeeded",
          targetId: project.id,
          targetType: "project",
        });
        return toProjectSummary(project, []);
      }),
    );
  }

  public async updateProject(command: UpdateProjectRecordCommand): Promise<ProjectSummary> {
    const repository = repositoryParts(command.configuration.repositoryUrl);

    return withNameConflict(() =>
      this.db.transaction(async (transaction) => {
        const [existing] = await transaction
          .select()
          .from(projects)
          .where(
            and(
              eq(projects.id, command.projectId),
              eq(projects.organizationId, command.organizationId),
              isNull(projects.archivedAt),
            ),
          )
          .for("update");
        if (existing === undefined) {
          throw new ProjectNotFoundError();
        }
        if (existing.version !== command.expectedVersion) {
          throw new ProjectConflictError("version_mismatch");
        }

        const now = new Date();
        const [project] = await transaction
          .update(projects)
          .set({
            defaultBranch: command.configuration.defaultBranch,
            dockerfilePath: command.configuration.dockerfilePath,
            healthCheckPath: command.configuration.healthCheckPath,
            healthCheckPort: command.configuration.healthCheckPort,
            name: command.configuration.name,
            repositoryName: repository.repositoryName,
            repositoryOwner: repository.repositoryOwner,
            runtimeConfig: command.configuration.runtimeConfig,
            updatedAt: now,
            version: existing.version + 1,
          })
          .where(eq(projects.id, existing.id))
          .returning();
        if (project === undefined) {
          throw new Error("Project update did not return a record");
        }

        await transaction.insert(auditEvents).values({
          action: "project.update",
          actorUserId: command.actorUserId,
          createdAt: now,
          metadata: { changedFields: changedConfigurationFields(existing, command) },
          organizationId: command.organizationId,
          outcome: "succeeded",
          targetId: project.id,
          targetType: "project",
        });
        const variables = await transaction
          .select()
          .from(environmentVariables)
          .where(eq(environmentVariables.projectId, project.id))
          .orderBy(asc(environmentVariables.name));
        return toProjectSummary(project, variables.map(toEnvironmentVariableMetadata));
      }),
    );
  }

  public async archiveProject(command: ArchiveProjectCommand): Promise<ProjectSummary> {
    return this.db.transaction(async (transaction) => {
      const [existing] = await transaction
        .select()
        .from(projects)
        .where(
          and(
            eq(projects.id, command.projectId),
            eq(projects.organizationId, command.organizationId),
            isNull(projects.archivedAt),
          ),
        )
        .for("update");
      if (existing === undefined) {
        throw new ProjectNotFoundError();
      }
      if (existing.version !== command.expectedVersion) {
        throw new ProjectConflictError("version_mismatch");
      }

      const [activeRelease] = await transaction
        .select({ deploymentId: activeReleases.deploymentId })
        .from(activeReleases)
        .where(
          and(
            eq(activeReleases.projectId, existing.id),
            eq(activeReleases.organizationId, command.organizationId),
          ),
        )
        .limit(1);
      if (activeRelease !== undefined) {
        throw new ProjectConflictError("project_in_use");
      }

      const [inUse] = await transaction
        .select({ id: deployments.id })
        .from(deployments)
        .where(
          and(
            eq(deployments.projectId, existing.id),
            eq(deployments.organizationId, command.organizationId),
            notInArray(deployments.state, inactiveDeploymentStates),
          ),
        )
        .limit(1);
      if (inUse !== undefined) {
        throw new ProjectConflictError("project_in_use");
      }

      const now = new Date();
      const [project] = await transaction
        .update(projects)
        .set({ archivedAt: now, updatedAt: now, version: existing.version + 1 })
        .where(eq(projects.id, existing.id))
        .returning();
      if (project === undefined) {
        throw new Error("Project archive did not return a record");
      }
      const deletedVariables = await transaction
        .delete(environmentVariables)
        .where(eq(environmentVariables.projectId, existing.id))
        .returning({ id: environmentVariables.id });
      await transaction.insert(auditEvents).values({
        action: "project.archive",
        actorUserId: command.actorUserId,
        createdAt: now,
        metadata: { deletedEnvironmentVariableCount: deletedVariables.length },
        organizationId: command.organizationId,
        outcome: "succeeded",
        targetId: project.id,
        targetType: "project",
      });
      return toProjectSummary(project, []);
    });
  }

  public async putEnvironmentVariable(
    command: PutProjectEnvironmentVariableRecordCommand,
  ): Promise<EnvironmentVariableMetadata> {
    const encrypted = await this.secretCipher.encrypt(new TextEncoder().encode(command.value), {
      organizationId: command.organizationId,
      projectId: command.projectId,
      variableName: command.name,
    });

    return this.db.transaction(async (transaction) => {
      const [project] = await transaction
        .select({ id: projects.id })
        .from(projects)
        .where(
          and(
            eq(projects.id, command.projectId),
            eq(projects.organizationId, command.organizationId),
            isNull(projects.archivedAt),
          ),
        )
        .for("update");
      if (project === undefined) {
        throw new ProjectNotFoundError();
      }

      const now = new Date();
      const [variable] = await transaction
        .insert(environmentVariables)
        .values({
          algorithm: encrypted.algorithm,
          authTag: encrypted.authenticationTag,
          createdAt: now,
          encryptedValue: encrypted.ciphertext,
          keyVersion: encrypted.keyVersion,
          name: command.name,
          nonce: encrypted.nonce,
          organizationId: command.organizationId,
          projectId: command.projectId,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          set: {
            algorithm: encrypted.algorithm,
            authTag: encrypted.authenticationTag,
            encryptedValue: encrypted.ciphertext,
            keyVersion: encrypted.keyVersion,
            nonce: encrypted.nonce,
            updatedAt: now,
          },
          target: [environmentVariables.projectId, environmentVariables.name],
        })
        .returning();
      if (variable === undefined) {
        throw new Error("Environment variable upsert did not return a record");
      }

      await transaction.insert(auditEvents).values({
        action: "project.environment_variable.put",
        actorUserId: command.actorUserId,
        createdAt: now,
        metadata: { name: command.name },
        organizationId: command.organizationId,
        outcome: "succeeded",
        targetId: command.projectId,
        targetType: "project",
      });
      return toEnvironmentVariableMetadata(variable);
    });
  }

  public async deleteEnvironmentVariable(
    command: DeleteProjectEnvironmentVariableRecordCommand,
  ): Promise<void> {
    await this.db.transaction(async (transaction) => {
      const [project] = await transaction
        .select({ id: projects.id })
        .from(projects)
        .where(
          and(
            eq(projects.id, command.projectId),
            eq(projects.organizationId, command.organizationId),
            isNull(projects.archivedAt),
          ),
        )
        .for("update");
      if (project === undefined) {
        throw new ProjectNotFoundError();
      }

      const [deleted] = await transaction
        .delete(environmentVariables)
        .where(
          and(
            eq(environmentVariables.projectId, command.projectId),
            eq(environmentVariables.organizationId, command.organizationId),
            eq(environmentVariables.name, command.name),
          ),
        )
        .returning({ id: environmentVariables.id });
      if (deleted === undefined) {
        throw new ProjectConflictError("environment_variable_not_found");
      }

      await transaction.insert(auditEvents).values({
        action: "project.environment_variable.delete",
        actorUserId: command.actorUserId,
        metadata: { name: command.name },
        organizationId: command.organizationId,
        outcome: "succeeded",
        targetId: command.projectId,
        targetType: "project",
      });
    });
  }
}
