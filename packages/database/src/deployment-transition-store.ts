import type {
  DeploymentTransitionResult,
  DeploymentTransitionStore,
  PromoteDeploymentCommand,
  RollbackDeploymentCommand,
  TransitionDeploymentCommand,
} from "@launchrail/application";
import {
  assertDeploymentTransition,
  requiresFailureDetails,
  type DeploymentState,
} from "@launchrail/domain";
import type { MetricsRegistry } from "@launchrail/observability";
import { and, eq, sql } from "drizzle-orm";
import { PostgresRollbackStore } from "./rollback-store.js";

import type { LaunchRailDatabase } from "./client.js";
import {
  activeReleases,
  auditEvents,
  deploymentCommands,
  deploymentEvents,
  deploymentJobs,
  deployments,
  projects,
  previewRoutes,
  runtimeInstances,
} from "./schema.js";
import { DeploymentNotFoundError, DeploymentPersistenceConflictError } from "./errors.js";

type PersistedTransitionResult = Omit<DeploymentTransitionResult, "idempotentReplay">;
type LaunchRailTransaction = Parameters<Parameters<LaunchRailDatabase["transaction"]>[0]>[0];
type FinalDeploymentOutcome =
  "active" | "build_failed" | "cancelled" | "deployment_failed" | "rolled_back" | "stopped";
const finalDeploymentStates = new Set<DeploymentState>([
  "active",
  "build_failed",
  "cancelled",
  "deployment_failed",
  "rolled_back",
  "stopped",
]);

function isFinalDeploymentOutcome(state: DeploymentState): state is FinalDeploymentOutcome {
  return finalDeploymentStates.has(state);
}

async function readDatabaseClock(transaction: LaunchRailTransaction): Promise<Date> {
  const result = await transaction.execute<{ now_milliseconds: number }>(
    sql`select (extract(epoch from clock_timestamp()) * 1000)::double precision as now_milliseconds`,
  );
  const now = new Date(result.rows[0]?.now_milliseconds ?? Number.NaN);
  if (!Number.isFinite(now.getTime())) {
    throw new Error("PostgreSQL did not return a valid transition clock");
  }
  return now;
}

function replayResult(result: PersistedTransitionResult): DeploymentTransitionResult {
  return { ...result, idempotentReplay: true };
}

function freshResult(result: PersistedTransitionResult): DeploymentTransitionResult {
  return { ...result, idempotentReplay: false };
}

function assertReplayTarget(
  result: PersistedTransitionResult,
  deploymentId: string,
  to: DeploymentState,
): void {
  if (result.deploymentId !== deploymentId || result.to !== to) {
    throw new DeploymentPersistenceConflictError(
      "Idempotency key was already used for a different deployment transition",
    );
  }
}

async function assertFailureReplayDetails(
  transaction: LaunchRailTransaction,
  result: PersistedTransitionResult,
  command: TransitionDeploymentCommand,
): Promise<void> {
  if (command.failure === undefined) {
    return;
  }

  const [event] = await transaction
    .select({ metadata: deploymentEvents.metadata })
    .from(deploymentEvents)
    .where(
      and(
        eq(deploymentEvents.deploymentId, command.deploymentId),
        eq(deploymentEvents.sequence, result.eventSequence),
      ),
    );
  if (
    event?.metadata.failureCategory !== command.failure.category ||
    event.metadata.failureMessage !== command.failure.message
  ) {
    throw new DeploymentPersistenceConflictError(
      "Idempotency key was already used with different deployment failure details",
    );
  }
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

export async function transitionDeploymentInTransaction(
  transaction: LaunchRailTransaction,
  command: TransitionDeploymentCommand,
): Promise<DeploymentTransitionResult> {
  assertTransitionCommand(command);

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
    assertReplayTarget(priorCommand.result, command.deploymentId, command.to);
    await assertFailureReplayDetails(transaction, priorCommand.result, command);
    return replayResult(priorCommand.result);
  }

  if (
    deployment.state === "active" &&
    (command.to === "rolling_back" || command.to === "superseded")
  ) {
    throw new DeploymentPersistenceConflictError(
      "Active-release transitions require an operation that updates the project pointer",
    );
  }

  assertDeploymentTransition(deployment.state, command.to);

  if (command.to === "cancelled") {
    const [leased] = await transaction
      .select({ id: deploymentJobs.id })
      .from(deploymentJobs)
      .where(
        and(
          eq(deploymentJobs.deploymentId, deployment.id),
          eq(deploymentJobs.organizationId, deployment.organizationId),
          eq(deploymentJobs.status, "running"),
          sql`${deploymentJobs.leaseExpiresAt} > clock_timestamp()`,
        ),
      )
      .limit(1);
    if (leased !== undefined)
      throw new DeploymentPersistenceConflictError("Deployment work is still leased");
  }

  if (
    deployment.state === "active" &&
    (command.to === "deployment_failed" || command.to === "stopped")
  ) {
    await transaction
      .delete(activeReleases)
      .where(
        and(
          eq(activeReleases.deploymentId, deployment.id),
          eq(activeReleases.projectId, deployment.projectId),
          eq(activeReleases.organizationId, deployment.organizationId),
        ),
      );
  }

  const eventSequence = deployment.eventSequence + 1;
  const version = deployment.version + 1;
  const now = await readDatabaseClock(transaction);

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

  if (deployment.state === "active" && command.to === "deployment_failed") {
    await transaction
      .update(runtimeInstances)
      .set({ cleanupState: "complete", state: "failed", updatedAt: now })
      .where(eq(runtimeInstances.deploymentId, deployment.id));
  }

  if (
    ["build_failed", "cancelled", "deployment_failed", "rolled_back", "stopped"].includes(
      command.to,
    )
  ) {
    await transaction.delete(previewRoutes).where(eq(previewRoutes.deploymentId, deployment.id));
  }

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
}

export class PostgresDeploymentTransitionStore implements DeploymentTransitionStore {
  public constructor(
    private readonly db: LaunchRailDatabase,
    private readonly metrics?: MetricsRegistry,
  ) {}

  private async recordFinalOutcome(
    deploymentId: string,
    organizationId: string,
    outcome: FinalDeploymentOutcome,
  ): Promise<void> {
    if (this.metrics === undefined) return;
    this.metrics.increment("launchrail_deployment_final_outcomes_total", { outcome });
    try {
      const [deployment] = await this.db
        .select({
          createdAt: deployments.createdAt,
          finishedAt: deployments.finishedAt,
          healthCheckedAt: deployments.healthCheckedAt,
          updatedAt: deployments.updatedAt,
        })
        .from(deployments)
        .where(
          and(eq(deployments.id, deploymentId), eq(deployments.organizationId, organizationId)),
        );
      if (deployment === undefined) return;
      const completedAt =
        outcome === "active"
          ? (deployment.healthCheckedAt ?? deployment.updatedAt)
          : (deployment.finishedAt ?? deployment.updatedAt);
      this.metrics.observe(
        "launchrail_deployment_lifecycle_duration_seconds",
        Math.max(0, completedAt.getTime() - deployment.createdAt.getTime()) / 1_000,
        { outcome },
        [1, 5, 15, 30, 60, 120, 300, 600, 1_200, 3_600],
      );
    } catch {
      this.metrics.increment("launchrail_deployment_metric_recording_failures_total");
    }
  }

  public async transition(
    command: TransitionDeploymentCommand,
  ): Promise<DeploymentTransitionResult> {
    const result = await this.db.transaction((transaction) =>
      transitionDeploymentInTransaction(transaction, command),
    );
    if (!result.idempotentReplay && isFinalDeploymentOutcome(command.to))
      await this.recordFinalOutcome(command.deploymentId, command.organizationId, command.to);
    return result;
  }

  public async listEvents(query: {
    readonly deploymentId: string;
    readonly organizationId: string;
    readonly limit: number;
  }) {
    if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 200)
      throw new RangeError("Deployment event history limit must be between 1 and 200");
    return this.db
      .select({
        createdAt: deploymentEvents.createdAt,
        fromState: deploymentEvents.fromState,
        kind: deploymentEvents.kind,
        metadata: deploymentEvents.metadata,
        sequence: deploymentEvents.sequence,
        toState: deploymentEvents.toState,
      })
      .from(deploymentEvents)
      .where(
        and(
          eq(deploymentEvents.deploymentId, query.deploymentId),
          eq(deploymentEvents.organizationId, query.organizationId),
        ),
      )
      .orderBy(sql`${deploymentEvents.sequence} desc`)
      .limit(query.limit);
  }

  public async listDeployments(query: {
    readonly limit: number;
    readonly organizationId: string;
    readonly projectId: string;
  }) {
    if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 200)
      throw new RangeError("Deployment history limit must be between 1 and 200");
    return this.db
      .select({
        createdAt: deployments.createdAt,
        deploymentId: deployments.id,
        finishedAt: deployments.finishedAt,
        healthCheckedAt: deployments.healthCheckedAt,
        previewHostname: previewRoutes.hostname,
        failureCategory: deployments.failureCategory,
        failureMessage: deployments.failureMessage,
        projectId: deployments.projectId,
        sourceRevision: deployments.sourceRevision,
        state: deployments.state,
      })
      .from(deployments)
      .leftJoin(
        previewRoutes,
        and(
          eq(previewRoutes.deploymentId, deployments.id),
          eq(previewRoutes.organizationId, deployments.organizationId),
        ),
      )
      .where(
        and(
          eq(deployments.organizationId, query.organizationId),
          eq(deployments.projectId, query.projectId),
        ),
      )
      .orderBy(sql`${deployments.createdAt} desc`)
      .limit(query.limit);
  }

  public async promote(command: PromoteDeploymentCommand): Promise<DeploymentTransitionResult> {
    if (command.idempotencyKey.trim().length === 0) {
      throw new DeploymentPersistenceConflictError("Idempotency key cannot be blank");
    }

    const result = await this.db.transaction(async (transaction) => {
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
        assertReplayTarget(priorCommand.result, command.deploymentId, "active");
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

      const now = await readDatabaseClock(transaction);

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
    if (!result.idempotentReplay)
      await this.recordFinalOutcome(command.deploymentId, command.organizationId, "active");
    return result;
  }

  public async rollback(command: RollbackDeploymentCommand): Promise<DeploymentTransitionResult> {
    return new PostgresRollbackStore(this.db).request(command);
  }
}
