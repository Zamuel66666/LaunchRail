import type {
  DeploymentTransitionResult,
  DeploymentTransitionStore,
  PromoteDeploymentCommand,
  TransitionDeploymentCommand,
} from "@launchrail/application";
import {
  assertDeploymentTransition,
  requiresFailureDetails,
  type DeploymentState,
} from "@launchrail/domain";
import { and, eq } from "drizzle-orm";

import type { LaunchRailDatabase } from "./client.js";
import {
  activeReleases,
  auditEvents,
  deploymentCommands,
  deploymentEvents,
  deployments,
  projects,
} from "./schema.js";
import { DeploymentNotFoundError, DeploymentPersistenceConflictError } from "./errors.js";

type PersistedTransitionResult = Omit<DeploymentTransitionResult, "idempotentReplay">;

function replayResult(result: PersistedTransitionResult): DeploymentTransitionResult {
  return { ...result, idempotentReplay: true };
}

function freshResult(result: PersistedTransitionResult): DeploymentTransitionResult {
  return { ...result, idempotentReplay: false };
}

function assertTransitionCommand(command: TransitionDeploymentCommand): void {
  if (command.idempotencyKey.trim().length === 0) {
    throw new DeploymentPersistenceConflictError("Idempotency key cannot be blank");
  }

  if (command.to === "active") {
    throw new DeploymentPersistenceConflictError(
      "Activation must use the transactional promotion operation",
    );
  }

  if (requiresFailureDetails(command.to) !== (command.failure !== undefined)) {
    throw new DeploymentPersistenceConflictError(
      requiresFailureDetails(command.to)
        ? "Failure transitions require a stable category and safe message"
        : "Failure details are only valid for failure transitions",
    );
  }

  if (command.failure !== undefined && command.failure.message.length > 512) {
    throw new DeploymentPersistenceConflictError("Failure messages must be at most 512 characters");
  }
}

export class PostgresDeploymentTransitionStore implements DeploymentTransitionStore {
  public constructor(private readonly db: LaunchRailDatabase) {}

  public async transition(
    command: TransitionDeploymentCommand,
  ): Promise<DeploymentTransitionResult> {
    assertTransitionCommand(command);

    return this.db.transaction(async (transaction) => {
      const [deployment] = await transaction
        .select()
        .from(deployments)
        .where(
          and(
            eq(deployments.id, command.deploymentId),
            eq(deployments.organizationId, command.organizationId),
          ),
        )
        .for("update");

      if (deployment === undefined) {
        throw new DeploymentNotFoundError();
      }

      const [priorCommand] = await transaction
        .select({ result: deploymentCommands.result })
        .from(deploymentCommands)
        .where(
          and(
            eq(deploymentCommands.deploymentId, command.deploymentId),
            eq(deploymentCommands.idempotencyKey, command.idempotencyKey),
          ),
        );

      if (priorCommand !== undefined) {
        return replayResult(priorCommand.result);
      }

      if (
        deployment.state === "active" &&
        (command.to === "rolling_back" || command.to === "stopped" || command.to === "superseded")
      ) {
        throw new DeploymentPersistenceConflictError(
          "Active-release transitions require an operation that updates the project pointer",
        );
      }

      assertDeploymentTransition(deployment.state, command.to);

      const eventSequence = deployment.eventSequence + 1;
      const version = deployment.version + 1;
      const now = new Date();

      await transaction
        .update(deployments)
        .set({
          eventSequence,
          failureCategory: command.failure?.category ?? null,
          failureMessage: command.failure?.message ?? null,
          finishedAt:
            command.to === "build_failed" ||
            command.to === "cancelled" ||
            command.to === "deployment_failed" ||
            command.to === "rolled_back" ||
            command.to === "stopped"
              ? now
              : null,
          state: command.to,
          updatedAt: now,
          version,
        })
        .where(eq(deployments.id, deployment.id));

      await transaction.insert(deploymentEvents).values({
        deploymentId: deployment.id,
        fromState: deployment.state,
        kind: "state_changed",
        metadata:
          command.failure === undefined
            ? {}
            : {
                failureCategory: command.failure.category,
                failureMessage: command.failure.message,
              },
        organizationId: deployment.organizationId,
        sequence: eventSequence,
        toState: command.to,
      });

      const result = {
        deploymentId: deployment.id,
        eventSequence,
        from: deployment.state,
        to: command.to,
        version,
      } satisfies PersistedTransitionResult;

      await transaction.insert(deploymentCommands).values({
        deploymentId: deployment.id,
        idempotencyKey: command.idempotencyKey,
        organizationId: deployment.organizationId,
        result,
      });

      await transaction.insert(auditEvents).values({
        action: "deployment.transition",
        ...(command.actorUserId === undefined ? {} : { actorUserId: command.actorUserId }),
        correlationId: command.idempotencyKey,
        metadata: { from: deployment.state, to: command.to },
        organizationId: deployment.organizationId,
        outcome: "succeeded",
        targetId: deployment.id,
        targetType: "deployment",
      });

      return freshResult(result);
    });
  }

  public async promote(command: PromoteDeploymentCommand): Promise<DeploymentTransitionResult> {
    if (command.idempotencyKey.trim().length === 0) {
      throw new DeploymentPersistenceConflictError("Idempotency key cannot be blank");
    }

    return this.db.transaction(async (transaction) => {
      const [candidate] = await transaction
        .select()
        .from(deployments)
        .where(
          and(
            eq(deployments.id, command.deploymentId),
            eq(deployments.organizationId, command.organizationId),
          ),
        )
        .for("update");

      if (candidate === undefined) {
        throw new DeploymentNotFoundError();
      }

      const [priorCommand] = await transaction
        .select({ result: deploymentCommands.result })
        .from(deploymentCommands)
        .where(
          and(
            eq(deploymentCommands.deploymentId, command.deploymentId),
            eq(deploymentCommands.idempotencyKey, command.idempotencyKey),
          ),
        );

      if (priorCommand !== undefined) {
        return replayResult(priorCommand.result);
      }

      const [project] = await transaction
        .select({ id: projects.id })
        .from(projects)
        .where(
          and(
            eq(projects.id, candidate.projectId),
            eq(projects.organizationId, command.organizationId),
          ),
        )
        .for("update");

      if (project === undefined) {
        throw new DeploymentNotFoundError();
      }

      assertDeploymentTransition(candidate.state, "active");
      if (candidate.healthCheckedAt === null) {
        throw new DeploymentPersistenceConflictError(
          "A deployment cannot be promoted before health checks pass",
        );
      }

      const [currentRelease] = await transaction
        .select({ deploymentId: activeReleases.deploymentId })
        .from(activeReleases)
        .where(eq(activeReleases.projectId, candidate.projectId))
        .for("update");

      const now = new Date();

      if (currentRelease !== undefined && currentRelease.deploymentId !== candidate.id) {
        const [previous] = await transaction
          .select()
          .from(deployments)
          .where(
            and(
              eq(deployments.id, currentRelease.deploymentId),
              eq(deployments.organizationId, command.organizationId),
            ),
          )
          .for("update");

        if (previous === undefined || previous.projectId !== candidate.projectId) {
          throw new DeploymentPersistenceConflictError(
            "The active release pointer violates project ownership",
          );
        }

        assertDeploymentTransition(previous.state, "superseded");
        const previousSequence = previous.eventSequence + 1;

        await transaction
          .update(deployments)
          .set({
            eventSequence: previousSequence,
            state: "superseded",
            updatedAt: now,
            version: previous.version + 1,
          })
          .where(eq(deployments.id, previous.id));

        await transaction.insert(deploymentEvents).values({
          deploymentId: previous.id,
          fromState: previous.state,
          kind: "release_superseded",
          metadata: { replacementDeploymentId: candidate.id },
          organizationId: previous.organizationId,
          sequence: previousSequence,
          toState: "superseded",
        });
      }

      const eventSequence = candidate.eventSequence + 1;
      const version = candidate.version + 1;

      await transaction
        .update(deployments)
        .set({
          eventSequence,
          state: "active",
          updatedAt: now,
          version,
        })
        .where(eq(deployments.id, candidate.id));

      await transaction.insert(deploymentEvents).values({
        deploymentId: candidate.id,
        fromState: candidate.state,
        kind: "release_activated",
        metadata: {},
        organizationId: candidate.organizationId,
        sequence: eventSequence,
        toState: "active",
      });

      await transaction
        .insert(activeReleases)
        .values({
          activatedAt: now,
          deploymentId: candidate.id,
          organizationId: candidate.organizationId,
          projectId: candidate.projectId,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          set: {
            activatedAt: now,
            deploymentId: candidate.id,
            organizationId: candidate.organizationId,
            updatedAt: now,
          },
          target: activeReleases.projectId,
        });

      const result = {
        deploymentId: candidate.id,
        eventSequence,
        from: candidate.state,
        to: "active" as DeploymentState,
        version,
      } satisfies PersistedTransitionResult;

      await transaction.insert(deploymentCommands).values({
        deploymentId: candidate.id,
        idempotencyKey: command.idempotencyKey,
        organizationId: candidate.organizationId,
        result,
      });

      await transaction.insert(auditEvents).values({
        action: "deployment.promote",
        ...(command.actorUserId === undefined ? {} : { actorUserId: command.actorUserId }),
        correlationId: command.idempotencyKey,
        metadata: { projectId: candidate.projectId },
        organizationId: candidate.organizationId,
        outcome: "succeeded",
        targetId: candidate.id,
        targetType: "deployment",
      });

      return freshResult(result);
    });
  }
}
