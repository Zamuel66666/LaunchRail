import type {
  CreateDeploymentCommand,
  CreatedDeployment,
  DeploymentCreationStore,
} from "@launchrail/application";
import { and, eq, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import type { LaunchRailDatabase } from "./client.js";
import { auditEvents, deployments, projects } from "./schema.js";
import { DeploymentNotFoundError } from "./errors.js";

export class PostgresDeploymentCreationStore implements DeploymentCreationStore {
  public constructor(private readonly db: LaunchRailDatabase) {}

  public async createDeployment(command: CreateDeploymentCommand): Promise<CreatedDeployment> {
    const [project] = await this.db
      .select()
      .from(projects)
      .where(
        and(
          eq(projects.id, command.projectId),
          eq(projects.organizationId, command.organizationId),
          isNull(projects.archivedAt),
        ),
      );
    if (project === undefined) throw new DeploymentNotFoundError();
    const deploymentId = randomUUID();
    await this.db.transaction(async (transaction) => {
      await transaction.insert(deployments).values({
        configurationSnapshot: {
          defaultBranch: project.defaultBranch,
          dockerfilePath: project.dockerfilePath,
          healthCheckPath: project.healthCheckPath,
          healthCheckPort: project.healthCheckPort,
          runtimeConfig: project.runtimeConfig,
        },
        id: deploymentId,
        organizationId: command.organizationId,
        projectId: command.projectId,
        sourceRevision: command.sourceRevision,
        sourceSnapshot: {
          contractVersion: 1,
          dockerfilePath: project.dockerfilePath,
          repositoryName: project.repositoryName,
          repositoryOwner: project.repositoryOwner,
          repositoryProvider: "github",
          requestedRevision: command.sourceRevision,
        },
      });
      await transaction.insert(auditEvents).values({
        action: "deployment.create",
        ...(command.actorUserId === undefined ? {} : { actorUserId: command.actorUserId }),
        metadata: { sourceRevision: command.sourceRevision },
        organizationId: command.organizationId,
        outcome: "succeeded",
        targetId: deploymentId,
        targetType: "deployment",
      });
    });
    return {
      deploymentId,
      organizationId: command.organizationId,
      projectId: command.projectId,
      sourceRevision: command.sourceRevision,
    };
  }
}
