import type {
  CreateDeploymentCommand,
  CreatedDeployment,
  DeploymentCreationStore,
} from "@launchrail/application";
import { and, eq, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import type { LaunchRailDatabase } from "./client.js";
import {
  auditEvents,
  deploymentEvents,
  deploymentJobs,
  deployments,
  projects,
  webhookDeploymentTriggers,
} from "./schema.js";
import { DeploymentNotFoundError, DeploymentPersistenceConflictError } from "./errors.js";

export class PostgresDeploymentCreationStore implements DeploymentCreationStore {
  public constructor(
    private readonly db: LaunchRailDatabase,
    private readonly defaultMaxAttempts = 5,
  ) {}

  public async createDeployment(command: CreateDeploymentCommand): Promise<CreatedDeployment> {
    if (
      command.traceParent !== undefined &&
      (!/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/u.test(command.traceParent) ||
        command.traceParent.slice(3, 35) === "0".repeat(32) ||
        command.traceParent.slice(36, 52) === "0".repeat(16))
    )
      throw new DeploymentPersistenceConflictError("Invalid deployment trace context");
    const maxAttempts = command.maxAttempts ?? this.defaultMaxAttempts;
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20)
      throw new RangeError("Deployment attempts must be between 1 and 20");
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
    const existingWebhookDeployment = async (): Promise<CreatedDeployment | null> => {
      if (command.sourceEvent === undefined) return null;
      const [existing] = await this.db
        .select({
          deploymentId: deployments.id,
          organizationId: deployments.organizationId,
          projectId: deployments.projectId,
          sourceRevision: deployments.sourceRevision,
        })
        .from(webhookDeploymentTriggers)
        .innerJoin(deployments, eq(webhookDeploymentTriggers.deploymentId, deployments.id))
        .where(
          and(
            eq(webhookDeploymentTriggers.organizationId, command.organizationId),
            eq(webhookDeploymentTriggers.provider, command.sourceEvent.provider),
            eq(webhookDeploymentTriggers.deliveryId, command.sourceEvent.deliveryId),
            eq(webhookDeploymentTriggers.projectId, projectId),
          ),
        );
      return existing ?? null;
    };
    const existing = await existingWebhookDeployment();
    if (existing !== null) return existing;
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
        throw new DeploymentPersistenceConflictError(
          "Only terminal failed deployments can be retried",
        );
    }
    const deploymentId = randomUUID();
    try {
      await this.db.transaction(async (transaction) => {
        const [project] = await transaction
          .select()
          .from(projects)
          .where(
            and(
              eq(projects.id, projectId),
              eq(projects.organizationId, command.organizationId),
              isNull(projects.archivedAt),
            ),
          )
          .for("update");
        if (project === undefined) throw new DeploymentNotFoundError();
        await transaction.insert(deployments).values({
          eventSequence: 1,
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
          traceParent: command.traceParent,
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
          sequence: 1,
          toState: "queued",
        });
        await transaction.insert(deploymentJobs).values({
          contractVersion: 1,
          deploymentId,
          organizationId: command.organizationId,
          kind: "deployment.claim",
          availableAt: new Date(),
          maxAttempts,
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
        if (command.sourceEvent !== undefined)
          await transaction.insert(webhookDeploymentTriggers).values({
            deploymentId,
            deliveryId: command.sourceEvent.deliveryId,
            organizationId: command.organizationId,
            projectId,
            provider: command.sourceEvent.provider,
          });
      });
    } catch (error) {
      const raced = await existingWebhookDeployment();
      if (raced !== null) return raced;
      throw error;
    }
    return {
      deploymentId,
      organizationId: command.organizationId,
      projectId,
      sourceRevision,
    };
  }
}
