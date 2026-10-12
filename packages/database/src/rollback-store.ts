import { randomUUID } from "node:crypto";
import type { MetricsRegistry } from "@launchrail/observability";
import { recordDeploymentOutcome } from "./outcome-metrics.js";
import type {
  DeploymentRollbackLease,
  DeploymentRollbackStore,
  DeploymentTransitionResult,
  RollbackDeploymentCommand,
} from "@launchrail/application";
import { normalizeProjectConfiguration, type ProjectRuntimeConfig } from "@launchrail/domain";
import { and, desc, eq, isNotNull, or, sql } from "drizzle-orm";
import type { LaunchRailDatabase } from "./client.js";
import { DeploymentNotFoundError, DeploymentPersistenceConflictError } from "./errors.js";
import {
  activeReleases,
  auditEvents,
  deploymentBuildArtifacts,
  deploymentCommands,
  deploymentEvents,
  deploymentJobs,
  deployments,
  healthCheckAttempts,
  previewRoutes,
  projects,
  rollbackRequests,
  runtimeInstances,
} from "./schema.js";

type Transaction = Parameters<Parameters<LaunchRailDatabase["transaction"]>[0]>[0];
type Request = typeof rollbackRequests.$inferSelect;
type Result = Parameters<DeploymentRollbackStore["finish"]>[0]["result"];
type RollbackObservation = {
  sourceDeploymentId: string;
  targetDeploymentId: string;
  organizationId: string;
  succeeded: boolean;
  durationSeconds: number;
};

function validateLeaseDuration(value: number) {
  if (!Number.isSafeInteger(value) || value < 1000 || value > 600000)
    throw new RangeError("Invalid rollback lease duration");
}

export class PostgresRollbackStore implements DeploymentRollbackStore {
  public constructor(
    private readonly db: LaunchRailDatabase,
    private readonly metrics?: MetricsRegistry,
  ) {}

  private async observeCommitted(observations: readonly RollbackObservation[]) {
    for (const observation of observations) {
      if (observation.succeeded) {
        await recordDeploymentOutcome(
          this.db,
          this.metrics,
          {
            deploymentId: observation.sourceDeploymentId,
            to: "rolled_back",
            idempotentReplay: false,
          },
          observation.organizationId,
        );
        await recordDeploymentOutcome(
          this.db,
          this.metrics,
          { deploymentId: observation.targetDeploymentId, to: "active", idempotentReplay: false },
          observation.organizationId,
        );
      }
      try {
        const outcome = observation.succeeded ? "completed" : "failed";
        this.metrics?.increment("launchrail_rollbacks_total", { outcome });
        this.metrics?.observe(
          "launchrail_rollback_duration_seconds",
          observation.durationSeconds,
          { outcome },
          [1, 5, 15, 30, 60, 120, 300, 600],
        );
      } catch {
        /* Telemetry cannot change committed release state. */
      }
    }
  }

  public async request(command: RollbackDeploymentCommand): Promise<DeploymentTransitionResult> {
    if (!command.idempotencyKey.trim() || command.idempotencyKey.length > 256)
      throw new DeploymentPersistenceConflictError("Invalid rollback idempotency key");
    return this.db.transaction(async (tx) => {
      const [located] = await tx
        .select()
        .from(deployments)
        .where(
          and(
            eq(deployments.id, command.deploymentId),
            eq(deployments.organizationId, command.organizationId),
          ),
        );
      if (!located) throw new DeploymentNotFoundError();
      await tx.select().from(projects).where(eq(projects.id, located.projectId)).for("update");
      const [current] = await tx
        .select()
        .from(deployments)
        .where(eq(deployments.id, located.id))
        .for("update");
      if (!current) throw new DeploymentNotFoundError();
      const [replay] = await tx
        .select()
        .from(deploymentCommands)
        .where(
          and(
            eq(deploymentCommands.deploymentId, current.id),
            eq(deploymentCommands.idempotencyKey, command.idempotencyKey),
          ),
        );
      if (replay) {
        if (replay.result.to !== "rolling_back")
          throw new DeploymentPersistenceConflictError(
            "Idempotency key belongs to another command",
          );
        return { ...replay.result, idempotentReplay: true };
      }
      const [pointer] = await tx
        .select()
        .from(activeReleases)
        .where(eq(activeReleases.projectId, current.projectId))
        .for("update");
      if (current.state !== "active" || pointer?.deploymentId !== current.id)
        throw new DeploymentPersistenceConflictError("Only the active release can be rolled back");
      const [target] = await tx
        .select()
        .from(deployments)
        .where(
          and(
            eq(deployments.projectId, current.projectId),
            eq(deployments.organizationId, command.organizationId),
            eq(deployments.state, "superseded"),
            isNotNull(deployments.healthCheckedAt),
          ),
        )
        .orderBy(desc(deployments.updatedAt), desc(deployments.id))
        .limit(1)
        .for("update");
      if (!target)
        throw new DeploymentPersistenceConflictError(
          "No previous healthy release is available for rollback",
        );
      await tx.insert(rollbackRequests).values({
        organizationId: command.organizationId,
        projectId: current.projectId,
        sourceDeploymentId: current.id,
        targetDeploymentId: target.id,
        idempotencyKey: command.idempotencyKey,
        actorUserId: command.actorUserId,
      });
      await tx
        .update(deployments)
        .set({
          state: "rolling_back",
          eventSequence: current.eventSequence + 1,
          version: current.version + 1,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(eq(deployments.id, current.id));
      await tx.insert(deploymentEvents).values({
        deploymentId: current.id,
        organizationId: command.organizationId,
        sequence: current.eventSequence + 1,
        kind: "rollback_requested",
        fromState: "active",
        toState: "rolling_back",
        metadata: { targetDeploymentId: target.id },
      });
      await tx.insert(auditEvents).values({
        organizationId: command.organizationId,
        actorUserId: command.actorUserId,
        action: "deployment.rollback_requested",
        targetType: "deployment",
        targetId: current.id,
        correlationId: command.idempotencyKey,
        outcome: "succeeded",
        metadata: { targetDeploymentId: target.id },
      });
      const result = {
        deploymentId: current.id,
        eventSequence: current.eventSequence + 1,
        version: current.version + 1,
        from: "active" as const,
        to: "rolling_back" as const,
      };
      await tx.insert(deploymentCommands).values({
        deploymentId: current.id,
        organizationId: command.organizationId,
        idempotencyKey: command.idempotencyKey,
        result,
      });
      return { ...result, idempotentReplay: false };
    });
  }

  public async claim(command: {
    workerId: string;
    leaseDurationMs: number;
  }): Promise<DeploymentRollbackLease | null> {
    validateLeaseDuration(command.leaseDurationMs);
    if (!command.workerId || command.workerId.length > 256)
      throw new RangeError("Invalid rollback worker identity");
    const observations: RollbackObservation[] = [];
    const result = await this.db.transaction<DeploymentRollbackLease | null>(async (tx) => {
      const [request] = await tx
        .select()
        .from(rollbackRequests)
        .where(
          or(
            eq(rollbackRequests.status, "pending"),
            and(
              eq(rollbackRequests.status, "running"),
              sql`${rollbackRequests.leaseExpiresAt} <= clock_timestamp()`,
            ),
          ),
        )
        .orderBy(rollbackRequests.createdAt, rollbackRequests.id)
        .limit(1)
        .for("update", { skipLocked: true });
      if (!request) return null;
      if (request.attemptCount >= 3) {
        await this.settle(
          tx,
          request,
          { errorCode: "rollback_lease_exhausted" },
          false,
          observations,
        );
        return null;
      }
      const leaseToken = randomUUID();
      await tx
        .update(rollbackRequests)
        .set({
          status: "running",
          attemptCount: request.attemptCount + 1,
          leaseToken,
          leaseExpiresAt: sql`clock_timestamp() + (${command.leaseDurationMs}::bigint * interval '1 millisecond')`,
          workerId: command.workerId,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(eq(rollbackRequests.id, request.id));
      const [target] = await tx
        .select()
        .from(deployments)
        .where(eq(deployments.id, request.targetDeploymentId));
      const [artifact] = await tx
        .select()
        .from(deploymentBuildArtifacts)
        .where(eq(deploymentBuildArtifacts.deploymentId, request.targetDeploymentId));
      const [runtimeJob] = await tx
        .select()
        .from(deploymentJobs)
        .where(
          and(
            eq(deploymentJobs.deploymentId, request.targetDeploymentId),
            eq(deploymentJobs.kind, "deployment.start_runtime"),
          ),
        );
      if (!target || target.state !== "superseded" || !artifact || !runtimeJob) {
        await this.settle(
          tx,
          request,
          { errorCode: "rollback_invalid_snapshot" },
          false,
          observations,
        );
        return null;
      }
      let config;
      try {
        config = normalizeProjectConfiguration({
          name: "Rollback snapshot",
          repositoryUrl: "https://github.com/launchrail/snapshot",
          defaultBranch: target.configurationSnapshot.defaultBranch as string,
          dockerfilePath: target.configurationSnapshot.dockerfilePath as string,
          healthCheckPath: target.configurationSnapshot.healthCheckPath as string,
          healthCheckPort: target.configurationSnapshot.healthCheckPort as number,
          runtimeConfig: target.configurationSnapshot.runtimeConfig as ProjectRuntimeConfig,
        });
      } catch {
        await this.settle(
          tx,
          request,
          { errorCode: "rollback_invalid_snapshot" },
          false,
          observations,
        );
        return null;
      }
      return {
        id: request.id,
        leaseToken,
        sourceDeploymentId: request.sourceDeploymentId,
        runtime: {
          deploymentId: target.id,
          organizationId: request.organizationId,
          projectId: request.projectId,
          workItemId: runtimeJob.id,
          healthCheckPath: config.healthCheckPath,
          healthCheckPort: config.healthCheckPort,
          runtimeConfig: config.runtimeConfig,
          imageId: artifact.imageId,
          imageReference: artifact.imageReference,
          manifestDigest: artifact.manifestDigest,
          platform: artifact.platform,
        },
      };
    });
    await this.observeCommitted(observations);
    return result;
  }

  public async heartbeat(command: {
    id: string;
    leaseToken: string;
    leaseDurationMs: number;
  }): Promise<boolean> {
    validateLeaseDuration(command.leaseDurationMs);
    const rows = await this.db
      .update(rollbackRequests)
      .set({
        leaseExpiresAt: sql`clock_timestamp() + (${command.leaseDurationMs}::bigint * interval '1 millisecond')`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(rollbackRequests.id, command.id),
          eq(rollbackRequests.status, "running"),
          eq(rollbackRequests.leaseToken, command.leaseToken),
          sql`${rollbackRequests.leaseExpiresAt} > clock_timestamp()`,
        ),
      )
      .returning({ id: rollbackRequests.id });
    return rows.length === 1;
  }

  public async finish(command: Parameters<DeploymentRollbackStore["finish"]>[0]): Promise<boolean> {
    const observations: RollbackObservation[] = [];
    const result = await this.db.transaction(async (tx) => {
      const [request] = await tx
        .select()
        .from(rollbackRequests)
        .where(
          and(
            eq(rollbackRequests.id, command.id),
            eq(rollbackRequests.status, "running"),
            eq(rollbackRequests.leaseToken, command.leaseToken),
            sql`${rollbackRequests.leaseExpiresAt} > clock_timestamp()`,
          ),
        )
        .for("update");
      if (!request) return false;
      return this.settle(tx, request, command.result, true, observations);
    });
    await this.observeCommitted(observations);
    return result;
  }

  private async settle(
    tx: Transaction,
    request: Request,
    result: Result | { errorCode: "rollback_lease_exhausted" },
    requireLease = false,
    observations: RollbackObservation[] = [],
  ) {
    await tx.select().from(projects).where(eq(projects.id, request.projectId)).for("update");
    const [current] = await tx
      .select()
      .from(deployments)
      .where(eq(deployments.id, request.sourceDeploymentId))
      .for("update");
    const [target] = await tx
      .select()
      .from(deployments)
      .where(eq(deployments.id, request.targetDeploymentId))
      .for("update");
    const [pointer] = await tx
      .select()
      .from(activeReleases)
      .where(eq(activeReleases.projectId, request.projectId))
      .for("update");
    const currentOwned = current?.state === "rolling_back" && pointer?.deploymentId === current.id;
    const valid = currentOwned && target?.state === "superseded";
    if (requireLease) {
      const [live] = await tx
        .select({ id: rollbackRequests.id })
        .from(rollbackRequests)
        .where(
          and(
            eq(rollbackRequests.id, request.id),
            eq(rollbackRequests.leaseToken, request.leaseToken!),
            sql`${rollbackRequests.leaseExpiresAt} > clock_timestamp()`,
          ),
        );
      if (!live) return false;
    }
    if (valid && !("errorCode" in result)) {
      const [artifact] = await tx
        .select()
        .from(deploymentBuildArtifacts)
        .where(eq(deploymentBuildArtifacts.deploymentId, request.targetDeploymentId));
      if (artifact?.manifestDigest !== result.runtime.imageDigest)
        throw new DeploymentPersistenceConflictError("Rollback image identity changed");
      if (
        !Number.isInteger(result.healthStatusCode) ||
        result.healthStatusCode < 200 ||
        result.healthStatusCode >= 300 ||
        !Number.isInteger(result.healthDurationMs) ||
        result.healthDurationMs < 0 ||
        result.healthDurationMs > 30000 ||
        !Number.isFinite(result.healthCheckedAt.getTime())
      )
        throw new RangeError("Invalid rollback health outcome");
      const [fresh] = await tx
        .select({ id: rollbackRequests.id })
        .from(rollbackRequests)
        .where(
          and(
            eq(rollbackRequests.id, request.id),
            sql`${result.healthCheckedAt} >= ${rollbackRequests.createdAt} and ${result.healthCheckedAt} <= clock_timestamp()`,
          ),
        );
      if (!fresh)
        throw new DeploymentPersistenceConflictError("Rollback health outcome is not fresh");
    }
    const succeeded = valid && !("errorCode" in result);
    const errorCode = valid
      ? "errorCode" in result
        ? result.errorCode
        : null
      : "rollback_state_conflict";
    const settled = await tx
      .update(rollbackRequests)
      .set({
        status: succeeded ? "completed" : "failed",
        errorCode,
        leaseToken: null,
        leaseExpiresAt: null,
        workerId: null,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(rollbackRequests.id, request.id),
          ...(requireLease
            ? [
                eq(rollbackRequests.status, "running"),
                eq(rollbackRequests.leaseToken, request.leaseToken!),
                sql`${rollbackRequests.leaseExpiresAt} > clock_timestamp()`,
              ]
            : []),
        ),
      )
      .returning({ id: rollbackRequests.id, updatedAt: rollbackRequests.updatedAt });
    if (settled.length === 0) return false;
    if (currentOwned && current && target) {
      const state = succeeded ? ("rolled_back" as const) : ("active" as const);
      await tx
        .update(deployments)
        .set({
          state,
          eventSequence: current.eventSequence + 1,
          version: current.version + 1,
          finishedAt: succeeded ? sql`clock_timestamp()` : null,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(eq(deployments.id, current.id));
      await tx.insert(deploymentEvents).values({
        deploymentId: current.id,
        organizationId: request.organizationId,
        sequence: current.eventSequence + 1,
        fromState: "rolling_back",
        toState: state,
        kind: succeeded ? "release_rolled_back" : "rollback_failed",
        metadata: { targetDeploymentId: target.id, ...(errorCode === null ? {} : { errorCode }) },
      });
      if (succeeded && !("errorCode" in result)) {
        const runtime = {
          ...result.runtime,
          deploymentId: target.id,
          organizationId: request.organizationId,
          state: "running" as const,
          cleanupState: "not_required" as const,
          updatedAt: sql`clock_timestamp()`,
        };
        await tx
          .insert(runtimeInstances)
          .values(runtime)
          .onConflictDoUpdate({ target: runtimeInstances.deploymentId, set: runtime });
        await tx
          .insert(previewRoutes)
          .values({
            deploymentId: target.id,
            organizationId: request.organizationId,
            hostname: `d-${target.id}.localhost`,
            hostPort: result.runtime.hostPort,
          })
          .onConflictDoUpdate({
            target: previewRoutes.deploymentId,
            set: { hostPort: result.runtime.hostPort, updatedAt: sql`clock_timestamp()` },
          });
        await tx
          .update(deployments)
          .set({
            state: "active",
            healthCheckedAt: result.healthCheckedAt,
            eventSequence: target.eventSequence + 1,
            version: target.version + 1,
            finishedAt: null,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(deployments.id, target.id));
        await tx.insert(healthCheckAttempts).values({
          deploymentId: target.id,
          organizationId: request.organizationId,
          outcome: "passed",
          statusCode: result.healthStatusCode,
          durationMs: result.healthDurationMs,
          checkedAt: result.healthCheckedAt,
        });
        await tx.insert(deploymentEvents).values({
          deploymentId: target.id,
          organizationId: request.organizationId,
          sequence: target.eventSequence + 1,
          fromState: "superseded",
          toState: "active",
          kind: "release_activated",
          metadata: { rollbackOfDeploymentId: current.id },
        });
        await tx
          .update(activeReleases)
          .set({
            deploymentId: target.id,
            activatedAt: sql`clock_timestamp()`,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(activeReleases.projectId, request.projectId));
      }
    }
    if (valid && !succeeded && "runtime" in result && result.runtime !== undefined) {
      const runtime = {
        ...result.runtime,
        deploymentId: request.targetDeploymentId,
        organizationId: request.organizationId,
        state: "failed" as const,
        cleanupState: "pending" as const,
        updatedAt: sql`clock_timestamp()`,
      };
      await tx
        .insert(runtimeInstances)
        .values(runtime)
        .onConflictDoUpdate({ target: runtimeInstances.deploymentId, set: runtime });
    }
    if (valid && "healthFailure" in result && result.healthFailure !== undefined) {
      await tx.insert(healthCheckAttempts).values({
        deploymentId: request.targetDeploymentId,
        organizationId: request.organizationId,
        outcome: "failed",
        ...result.healthFailure,
      });
    }
    await tx.insert(auditEvents).values({
      organizationId: request.organizationId,
      actorUserId: request.actorUserId,
      action: "deployment.rollback",
      targetType: "deployment",
      targetId: request.sourceDeploymentId,
      correlationId: request.idempotencyKey,
      outcome: succeeded ? "succeeded" : "failed",
      metadata: {
        targetDeploymentId: request.targetDeploymentId,
        ...(errorCode === null ? {} : { errorCode }),
      },
    });
    observations.push({
      sourceDeploymentId: request.sourceDeploymentId,
      targetDeploymentId: request.targetDeploymentId,
      organizationId: request.organizationId,
      succeeded,
      durationSeconds:
        Math.max(0, settled[0]!.updatedAt.getTime() - request.createdAt.getTime()) / 1000,
    });
    return currentOwned;
  }
}
