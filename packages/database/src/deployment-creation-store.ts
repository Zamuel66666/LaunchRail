import type {
  CreateDeploymentCommand,
  CreatedDeployment,
  DeploymentCreationStore,
} from "@launchrail/application";
import { and, eq, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import type { LaunchRailDatabase } from "./client.js";
import { auditEvents, deploymentEvents, deployments, projects } from "./schema.js";
import { DeploymentNotFoundError } from "./errors.js";

export class PostgresDeploymentCreationStore implements DeploymentCreationStore {
  public constructor(private readonly db: LaunchRailDatabase) {}

  public async createDeployment(command: CreateDeploymentCommand): Promise<CreatedDeployment> {
    let sourceRevision = command.sourceRevision;
    if (sourceRevision === undefined && command.retryOfDeploymentId !== undefined) {
      const [original] = await this.db
        .select({ sourceRevision: deployments.sourceRevision })
        .from(deployments)
        .where(
          and(
            eq(deployments.id, command.retryOfDeploymentId),
            eq(deployments.organizationId, command.organizationId),
          ),
        );
      sourceRevision = original?.sourceRevision;
    }
    if (sourceRevision === undefined || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(sourceRevision))
      throw new RangeError("sourceRevision must be a lowercase Git object ID");
    let projectId = command.projectId;
    if (projectId === undefined && command.retryOfDeploymentId !== undefined) {
      const [original] = await this.db
        .select({ projectId: deployments.projectId })
        .from(deployments)
        .where(
          and(
            eq(deployments.id, command.retryOfDeploymentId),
            eq(deployments.organizationId, command.organizationId),
          ),
        );
      projectId = original?.projectId;
    }
    if (projectId === undefined) throw new DeploymentNotFoundError();
    const [project] = await this.db
      .select()
      .from(projects)
      .where(
        and(
          eq(projects.id, projectId),
          eq(projects.organizationId, command.organizationId),
          isNull(projects.archivedAt),
        ),
      );
    if (project === undefined) throw new DeploymentNotFoundError();
    if (command.retryOfDeploymentId !== undefined) {
      const [original] = await this.db
        .select({
          projectId: deployments.projectId,
          organizationId: deployments.organizationId,
          state: deployments.state,
        })
        .from(deployments)
        .where(
          and(
            eq(deployments.id, command.retryOfDeploymentId),
            eq(deployments.organizationId, command.organizationId),
          ),
        );
      if (original === undefined || original.projectId !== projectId)
        throw new DeploymentNotFoundError();
      if (!["build_failed", "deployment_failed", "cancelled"].includes(original.state))
        throw new Error("Only terminal failed deployments can be retried");
    }
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
        projectId,
        retryOfDeploymentId: command.retryOfDeploymentId,
        sourceRevision,
        sourceSnapshot: {
          contractVersion: 1,
          dockerfilePath: project.dockerfilePath,
          repositoryName: project.repositoryName,
          repositoryOwner: project.repositoryOwner,
          repositoryProvider: "github",
          requestedRevision: sourceRevision,
        },
      });
      await transaction.insert(deploymentEvents).values({
        deploymentId,
        fromState: null,
        kind: "deployment_created",
        metadata: {},
        organizationId: command.organizationId,
        sequence: 0,
        toState: "queued",
      });
      await transaction.insert(auditEvents).values({
        action: "deployment.create",
        ...(command.actorUserId === undefined ? {} : { actorUserId: command.actorUserId }),
        metadata: {
          sourceRevision,
          ...(command.retryOfDeploymentId === undefined
            ? {}
            : { retryOfDeploymentId: command.retryOfDeploymentId }),
        },
        organizationId: command.organizationId,
        outcome: "succeeded",
        targetId: deploymentId,
        targetType: "deployment",
      });
    });
    return {
      deploymentId,
      organizationId: command.organizationId,
      projectId,
      sourceRevision,
    };
  }
}
