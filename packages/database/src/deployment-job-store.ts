import { randomUUID } from "node:crypto";

import type {
  ClaimDeploymentJobCommand,
  ClaimDeploymentJobResult,
  CompleteDeploymentClaimTransitionCommand,
  CompleteDeploymentClaimTransitionResult,
  DeploymentJobStore,
  DeploymentJobSummary,
  DispatchableDeploymentJob,
  EnsureDeploymentClaimJobCommand,
  EnsureDeploymentClaimJobResult,
  EnsureMissingDeploymentClaimJobsCommand,
  FailDeploymentJobCommand,
  FailDeploymentJobResult,
  HeartbeatDeploymentJobCommand,
  HeartbeatDeploymentJobResult,
  ListDispatchableDeploymentJobsQuery,
  ListWorkerHeartbeatsQuery,
  LeaseMutationFailure,
  RecordWorkerHeartbeatCommand,
  RecordWorkerHeartbeatResult,
  RecoverExpiredDeploymentJobsCommand,
  RecoveredDeploymentJob,
  WorkerHeartbeatFreshness,
  WorkerHeartbeatStatus,
  WorkerHeartbeatSummary,
} from "@launchrail/application";
import { createDeploymentClaimTransitionIdempotencyKey } from "@launchrail/contracts";
import { and, asc, eq, getTableColumns, gt, inArray, lte, notExists, sql } from "drizzle-orm";

import type { LaunchRailDatabase } from "./client.js";
import { transitionDeploymentInTransaction } from "./deployment-transition-store.js";
import { deploymentJobs, deployments, workerHeartbeats } from "./schema.js";

const deploymentJobKind = "deployment.claim" as const;
const deploymentJobContractVersion = 1;
const maximumBatchSize = 1_000;
const maximumAttempts = 100;
const maximumLeaseDurationMs = 24 * 60 * 60 * 1_000;
const maximumRetryDelayMs = 30 * 24 * 60 * 60 * 1_000;
const maximumStaleWindowMs = 30 * 24 * 60 * 60 * 1_000;
const workerIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const workerVersionPattern = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const safeErrorCodePattern = /^[a-z][a-z0-9_]{0,63}$/;
const controlCharacterPattern = /[\u0000-\u001f\u007f-\u009f]/u;

const workerTransitions: Readonly<
  Record<WorkerHeartbeatStatus, ReadonlySet<WorkerHeartbeatStatus>>
> = {
  draining: new Set(["draining", "stopped"]),
  ready: new Set(["ready", "draining", "stopped"]),
  starting: new Set(["starting", "ready", "draining", "stopped"]),
  stopped: new Set(["stopped"]),
};

class AtomicClaimLeaseFailure extends Error {
  public constructor(readonly result: LeaseMutationFailure) {
    super(`Atomic deployment claim completion failed: ${result.kind}`);
  }
}

type DeploymentJobRow = typeof deploymentJobs.$inferSelect;
type LaunchRailTransaction = Parameters<Parameters<LaunchRailDatabase["transaction"]>[0]>[0];
type WorkerHeartbeatRow = typeof workerHeartbeats.$inferSelect;

function assertDate(value: Date, field: string): void {
  if (!Number.isFinite(value.getTime())) {
    throw new RangeError(`${field} must be a valid date`);
  }
}

async function readDatabaseClock(transaction: LaunchRailTransaction): Promise<Date> {
  const result = await transaction.execute<{ now_milliseconds: number }>(
    sql`select (extract(epoch from clock_timestamp()) * 1000)::double precision as now_milliseconds`,
  );
  const now = new Date(result.rows[0]?.now_milliseconds ?? Number.NaN);
  assertDate(now, "database clock");
  return now;
}

function assertIntegerInRange(
  value: number,
  field: string,
  minimum: number,
  maximum: number,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
}

function assertBatchSize(limit: number): void {
  assertIntegerInRange(limit, "limit", 1, maximumBatchSize);
}

function assertMaxAttempts(value: number): void {
  assertIntegerInRange(value, "maxAttempts", 1, maximumAttempts);
}

function assertLeaseDuration(value: number): void {
  assertIntegerInRange(value, "leaseDurationMs", 1, maximumLeaseDurationMs);
}

function assertWorkerId(value: string): void {
  if (!workerIdPattern.test(value)) {
    throw new RangeError("workerId must be a bounded opaque identifier");
  }
}

function assertWorkerVersion(value: string): void {
  if (!workerVersionPattern.test(value)) {
    throw new RangeError("version must be a bounded release identifier");
  }
}

function assertSafeFailure(code: string, message: string): void {
  if (!safeErrorCodePattern.test(code)) {
    throw new RangeError("safeErrorCode must be a bounded lowercase identifier");
  }
  if (
    message.length === 0 ||
    message.length > 512 ||
    message !== message.trim() ||
    controlCharacterPattern.test(message)
  ) {
    throw new RangeError("safeErrorMessage must be 1 to 512 printable trimmed characters");
  }
}

function toJobSummary(row: DeploymentJobRow): DeploymentJobSummary {
  return {
    attemptCount: row.attemptCount,
    availableAt: row.availableAt,
    completedAt: row.completedAt,
    contractVersion: row.contractVersion,
    createdAt: row.createdAt,
    deadLetteredAt: row.deadLetteredAt,
    deploymentId: row.deploymentId,
    heartbeatAt: row.heartbeatAt,
    id: row.id,
    kind: deploymentJobKind,
    lastErrorCode: row.lastErrorCode,
    lastErrorMessage: row.lastErrorMessage,
    leaseExpiresAt: row.leaseExpiresAt,
    leaseToken: row.leaseToken,
    maxAttempts: row.maxAttempts,
    organizationId: row.organizationId,
    status: row.status,
    updatedAt: row.updatedAt,
    workerId: row.workerId,
  };
}

function toWorkerSummary(
  row: WorkerHeartbeatRow,
  freshness: WorkerHeartbeatFreshness,
): WorkerHeartbeatSummary {
  return {
    activeJobCount: row.activeJobCount,
    freshness,
    heartbeatAt: row.heartbeatAt,
    startedAt: row.startedAt,
    status: row.status,
    stoppedAt: row.stoppedAt,
    version: row.version,
    workerId: row.workerId,
  };
}

export interface PostgresDeploymentJobStoreOptions {
  readonly afterInitialClaimLeaseValidation?: () => Promise<void>;
  readonly generateLeaseToken?: () => string;
}

export class PostgresDeploymentJobStore implements DeploymentJobStore {
  private readonly afterInitialClaimLeaseValidation: () => Promise<void>;
  private readonly generateLeaseToken: () => string;

  public constructor(
    private readonly db: LaunchRailDatabase,
    {
      afterInitialClaimLeaseValidation = () => Promise.resolve(),
      generateLeaseToken = randomUUID,
    }: PostgresDeploymentJobStoreOptions = {},
  ) {
    this.afterInitialClaimLeaseValidation = afterInitialClaimLeaseValidation;
    this.generateLeaseToken = generateLeaseToken;
  }

  public async ensurePendingClaim(
    command: EnsureDeploymentClaimJobCommand,
  ): Promise<EnsureDeploymentClaimJobResult> {
    assertDate(command.availableAt, "availableAt");
    assertMaxAttempts(command.maxAttempts);

    return this.db.transaction(async (transaction) => {
      const [existingBeforeLock] = await transaction
        .select()
        .from(deploymentJobs)
        .where(
          and(
            eq(deploymentJobs.deploymentId, command.deploymentId),
            eq(deploymentJobs.organizationId, command.organizationId),
            eq(deploymentJobs.kind, deploymentJobKind),
          ),
        )
        .for("update");
      if (existingBeforeLock !== undefined) {
        return { job: toJobSummary(existingBeforeLock), kind: "existing" };
      }

      const [deployment] = await transaction
        .select({ id: deployments.id, state: deployments.state })
        .from(deployments)
        .where(
          and(
            eq(deployments.id, command.deploymentId),
            eq(deployments.organizationId, command.organizationId),
          ),
        )
        .for("update");

      if (deployment === undefined) {
        return { kind: "deployment_not_found" };
      }

      const [existingAfterLock] = await transaction
        .select()
        .from(deploymentJobs)
        .where(
          and(
            eq(deploymentJobs.deploymentId, command.deploymentId),
            eq(deploymentJobs.organizationId, command.organizationId),
            eq(deploymentJobs.kind, deploymentJobKind),
          ),
        );
      if (existingAfterLock !== undefined) {
        return { job: toJobSummary(existingAfterLock), kind: "existing" };
      }
      if (deployment.state !== "queued") {
        return { kind: "deployment_ineligible", state: deployment.state };
      }

      const [created] = await transaction
        .insert(deploymentJobs)
        .values({
          availableAt: command.availableAt,
          contractVersion: deploymentJobContractVersion,
          deploymentId: command.deploymentId,
          kind: deploymentJobKind,
          maxAttempts: command.maxAttempts,
          organizationId: command.organizationId,
        })
        .onConflictDoNothing({
          target: [deploymentJobs.deploymentId, deploymentJobs.kind],
        })
        .returning();
      if (created !== undefined) {
        return { job: toJobSummary(created), kind: "created" };
      }

      const [concurrent] = await transaction
        .select()
        .from(deploymentJobs)
        .where(
          and(
            eq(deploymentJobs.deploymentId, command.deploymentId),
            eq(deploymentJobs.organizationId, command.organizationId),
            eq(deploymentJobs.kind, deploymentJobKind),
          ),
        );
      if (concurrent === undefined) {
        throw new Error("Deployment job insert did not create or find a row");
      }
      return { job: toJobSummary(concurrent), kind: "existing" };
    });
  }

  public async ensureMissingClaims(
    command: EnsureMissingDeploymentClaimJobsCommand,
  ): Promise<readonly DeploymentJobSummary[]> {
    assertBatchSize(command.limit);
    assertMaxAttempts(command.maxAttempts);

    return this.db.transaction(async (transaction) => {
      const candidates = await transaction
        .select({ id: deployments.id, organizationId: deployments.organizationId })
        .from(deployments)
        .where(
          and(
            eq(deployments.state, "queued"),
            notExists(
              transaction
                .select({ id: deploymentJobs.id })
                .from(deploymentJobs)
                .where(
                  and(
                    eq(deploymentJobs.deploymentId, deployments.id),
                    eq(deploymentJobs.kind, deploymentJobKind),
                  ),
                ),
            ),
          ),
        )
        .orderBy(asc(deployments.createdAt), asc(deployments.id))
        .limit(command.limit)
        .for("update", { skipLocked: true });

      if (candidates.length === 0) {
        return [];
      }

      const created = await transaction
        .insert(deploymentJobs)
        .values(
          candidates.map((candidate) => ({
            availableAt: sql<Date>`clock_timestamp()`,
            contractVersion: deploymentJobContractVersion,
            deploymentId: candidate.id,
            kind: deploymentJobKind,
            maxAttempts: command.maxAttempts,
            organizationId: candidate.organizationId,
          })),
        )
        .onConflictDoNothing({
          target: [deploymentJobs.deploymentId, deploymentJobs.kind],
        })
        .returning();
      return created.map(toJobSummary);
    });
  }

  public async listDispatchable(
    query: ListDispatchableDeploymentJobsQuery,
  ): Promise<readonly DispatchableDeploymentJob[]> {
    assertBatchSize(query.limit);

    return this.db
      .select({
        contractVersion: deploymentJobs.contractVersion,
        id: deploymentJobs.id,
        kind: deploymentJobs.kind,
      })
      .from(deploymentJobs)
      .where(
        and(
          inArray(deploymentJobs.status, ["pending", "retry_wait"]),
          lte(deploymentJobs.availableAt, sql`clock_timestamp()`),
        ),
      )
      .orderBy(asc(deploymentJobs.availableAt), asc(deploymentJobs.id))
      .limit(query.limit)
      .then((rows) =>
        rows.map((row) => ({
          contractVersion: row.contractVersion,
          id: row.id,
          kind: deploymentJobKind,
        })),
      );
  }

  public async claim(command: ClaimDeploymentJobCommand): Promise<ClaimDeploymentJobResult> {
    assertLeaseDuration(command.leaseDurationMs);
    assertWorkerId(command.workerId);

    return this.db.transaction(async (transaction) => {
      const [job] = await transaction
        .select()
        .from(deploymentJobs)
        .where(eq(deploymentJobs.id, command.workItemId))
        .for("update");
      if (job === undefined) {
        return { kind: "not_found" };
      }
      if (job.status === "completed" || job.status === "dead_lettered") {
        return { kind: job.status };
      }

      const [deployment] = await transaction
        .select()
        .from(deployments)
        .where(
          and(
            eq(deployments.id, job.deploymentId),
            eq(deployments.organizationId, job.organizationId),
          ),
        )
        .for("update");
      if (deployment === undefined) {
        return { kind: "not_found" };
      }

      if (deployment.state !== "queued") {
        const completionClock = transaction
          .select({ now: sql<Date>`clock_timestamp()`.as("now") })
          .from(sql`(select 1) as clock_source`)
          .as("completion_clock");
        await transaction
          .update(deploymentJobs)
          .set({
            completedAt: sql<Date>`${completionClock.now}`,
            deadLetteredAt: null,
            heartbeatAt: null,
            lastErrorCode: null,
            lastErrorMessage: null,
            leaseExpiresAt: null,
            leaseToken: null,
            status: "completed",
            updatedAt: sql<Date>`${completionClock.now}`,
            workerId: null,
          })
          .from(completionClock)
          .where(eq(deploymentJobs.id, job.id));
        return { kind: "completed" };
      }

      if (job.status === "running" && job.leaseExpiresAt !== null) {
        const [currentLease] = await transaction
          .select({ id: deploymentJobs.id })
          .from(deploymentJobs)
          .where(
            and(
              eq(deploymentJobs.id, job.id),
              gt(deploymentJobs.leaseExpiresAt, sql`clock_timestamp()`),
            ),
          );
        if (currentLease !== undefined) {
          return { kind: "busy", leaseExpiresAt: job.leaseExpiresAt };
        }
      }
      if (job.status === "pending" || job.status === "retry_wait") {
        const [notDue] = await transaction
          .select({ id: deploymentJobs.id })
          .from(deploymentJobs)
          .where(
            and(
              eq(deploymentJobs.id, job.id),
              gt(deploymentJobs.availableAt, sql`clock_timestamp()`),
            ),
          );
        if (notDue !== undefined) {
          return { availableAt: job.availableAt, kind: "not_due" };
        }
      }

      if (job.attemptCount >= job.maxAttempts) {
        const deadLetterClock = transaction
          .select({ now: sql<Date>`clock_timestamp()`.as("now") })
          .from(sql`(select 1) as clock_source`)
          .as("dead_letter_clock");
        await transaction
          .update(deploymentJobs)
          .set({
            deadLetteredAt: sql<Date>`${deadLetterClock.now}`,
            heartbeatAt: null,
            lastErrorCode: "worker_lease_expired",
            lastErrorMessage: "Worker lease expired before the job completed",
            leaseExpiresAt: null,
            leaseToken: null,
            status: "dead_lettered",
            updatedAt: sql<Date>`${deadLetterClock.now}`,
            workerId: null,
          })
          .from(deadLetterClock)
          .where(eq(deploymentJobs.id, job.id));
        return { kind: "dead_lettered" };
      }

      const attemptCount = job.attemptCount + 1;
      const leaseToken = this.generateLeaseToken();
      const claimClock = transaction
        .select({ now: sql<Date>`clock_timestamp()`.as("now") })
        .from(sql`(select 1) as clock_source`)
        .as("claim_clock");

      const [claimedJob] = await transaction
        .update(deploymentJobs)
        .set({
          attemptCount,
          heartbeatAt: sql<Date>`${claimClock.now}`,
          lastErrorCode: null,
          lastErrorMessage: null,
          leaseExpiresAt: sql<Date>`${claimClock.now} + (${command.leaseDurationMs}::bigint * interval '1 millisecond')`,
          leaseToken,
          status: "running",
          updatedAt: sql<Date>`${claimClock.now}`,
          workerId: command.workerId,
        })
        .from(claimClock)
        .where(eq(deploymentJobs.id, job.id))
        .returning({
          heartbeatAt: deploymentJobs.heartbeatAt,
          leaseExpiresAt: deploymentJobs.leaseExpiresAt,
        });
      if (
        claimedJob === undefined ||
        claimedJob.heartbeatAt === null ||
        claimedJob.leaseExpiresAt === null
      ) {
        throw new Error("Deployment job claim did not return its database-clock lease");
      }
      await transaction
        .update(deployments)
        .set({
          attempt: deployment.attempt + 1,
          startedAt: deployment.startedAt ?? claimedJob.heartbeatAt,
          updatedAt: claimedJob.heartbeatAt,
        })
        .where(eq(deployments.id, deployment.id));

      return {
        kind: "claimed",
        lease: {
          attemptCount,
          deploymentId: deployment.id,
          leaseExpiresAt: claimedJob.leaseExpiresAt,
          leaseToken,
          organizationId: deployment.organizationId,
          workItemId: job.id,
        },
      };
    });
  }

  public async heartbeat(
    command: HeartbeatDeploymentJobCommand,
  ): Promise<HeartbeatDeploymentJobResult> {
    assertLeaseDuration(command.leaseDurationMs);

    return this.db.transaction(async (transaction) => {
      const [job] = await transaction
        .select()
        .from(deploymentJobs)
        .where(eq(deploymentJobs.id, command.workItemId))
        .for("update");
      if (job === undefined) {
        return { kind: "not_found" };
      }
      if (job.status !== "running") {
        return { kind: "not_running", status: job.status };
      }
      if (job.leaseToken !== command.leaseToken) {
        return { kind: "lease_mismatch" };
      }

      const heartbeatClock = transaction
        .select({ now: sql<Date>`clock_timestamp()`.as("now") })
        .from(sql`(select 1) as clock_source`)
        .as("heartbeat_clock");
      const [extended] = await transaction
        .update(deploymentJobs)
        .set({
          heartbeatAt: sql<Date>`${heartbeatClock.now}`,
          leaseExpiresAt: sql<Date>`${heartbeatClock.now} + (${command.leaseDurationMs}::bigint * interval '1 millisecond')`,
          updatedAt: sql<Date>`${heartbeatClock.now}`,
        })
        .from(heartbeatClock)
        .where(
          and(
            eq(deploymentJobs.id, command.workItemId),
            eq(deploymentJobs.status, "running"),
            eq(deploymentJobs.leaseToken, command.leaseToken),
            gt(deploymentJobs.leaseExpiresAt, heartbeatClock.now),
          ),
        )
        .returning({ leaseExpiresAt: deploymentJobs.leaseExpiresAt });
      if (extended?.leaseExpiresAt === undefined || extended.leaseExpiresAt === null) {
        return { kind: "lease_expired" };
      }
      return { kind: "extended", leaseExpiresAt: extended.leaseExpiresAt };
    });
  }

  public async completeClaimTransition(
    command: CompleteDeploymentClaimTransitionCommand,
  ): Promise<CompleteDeploymentClaimTransitionResult> {
    try {
      return await this.db.transaction(async (transaction) => {
        const [job] = await transaction
          .select()
          .from(deploymentJobs)
          .where(eq(deploymentJobs.id, command.workItemId))
          .for("update");
        if (job === undefined) {
          return { kind: "not_found" };
        }
        if (job.status !== "running") {
          return { kind: "not_running", status: job.status };
        }
        if (job.leaseToken !== command.leaseToken) {
          return { kind: "lease_mismatch" };
        }
        const [currentLease] = await transaction
          .select({ id: deploymentJobs.id })
          .from(deploymentJobs)
          .where(
            and(
              eq(deploymentJobs.id, command.workItemId),
              eq(deploymentJobs.status, "running"),
              eq(deploymentJobs.leaseToken, command.leaseToken),
              gt(deploymentJobs.leaseExpiresAt, sql`clock_timestamp()`),
            ),
          );
        if (currentLease === undefined) {
          return { kind: "lease_expired" };
        }
        await this.afterInitialClaimLeaseValidation();

        const transition = await transitionDeploymentInTransaction(transaction, {
          deploymentId: job.deploymentId,
          idempotencyKey: createDeploymentClaimTransitionIdempotencyKey(job.id),
          organizationId: job.organizationId,
          to: "cloning",
        });

        const completionClock = transaction
          .select({ now: sql<Date>`clock_timestamp()`.as("now") })
          .from(sql`(select 1) as clock_source`)
          .as("atomic_completion_clock");
        const [completed] = await transaction
          .update(deploymentJobs)
          .set({
            completedAt: sql<Date>`${completionClock.now}`,
            deadLetteredAt: null,
            heartbeatAt: null,
            lastErrorCode: null,
            lastErrorMessage: null,
            leaseExpiresAt: null,
            leaseToken: null,
            status: "completed",
            updatedAt: sql<Date>`${completionClock.now}`,
            workerId: null,
          })
          .from(completionClock)
          .where(
            and(
              eq(deploymentJobs.id, command.workItemId),
              eq(deploymentJobs.status, "running"),
              eq(deploymentJobs.leaseToken, command.leaseToken),
              gt(deploymentJobs.leaseExpiresAt, completionClock.now),
            ),
          )
          .returning({ id: deploymentJobs.id });

        if (completed === undefined) {
          const [currentJob] = await transaction
            .select()
            .from(deploymentJobs)
            .where(eq(deploymentJobs.id, command.workItemId));
          const finalFailure: LeaseMutationFailure =
            currentJob === undefined
              ? { kind: "not_found" }
              : currentJob.status !== "running"
                ? { kind: "not_running", status: currentJob.status }
                : currentJob.leaseToken !== command.leaseToken
                  ? { kind: "lease_mismatch" }
                  : { kind: "lease_expired" };
          throw new AtomicClaimLeaseFailure(finalFailure);
        }

        return { kind: "completed", transition };
      });
    } catch (error) {
      if (error instanceof AtomicClaimLeaseFailure) {
        return error.result;
      }
      throw error;
    }
  }

  public async fail(command: FailDeploymentJobCommand): Promise<FailDeploymentJobResult> {
    assertIntegerInRange(command.retryDelayMs, "retryDelayMs", 0, maximumRetryDelayMs);
    assertSafeFailure(command.safeErrorCode, command.safeErrorMessage);

    return this.db.transaction(async (transaction) => {
      const [job] = await transaction
        .select()
        .from(deploymentJobs)
        .where(eq(deploymentJobs.id, command.workItemId))
        .for("update");
      if (job === undefined) {
        return { kind: "not_found" };
      }
      if (job.status !== "running") {
        return { kind: "not_running", status: job.status };
      }
      if (job.leaseToken !== command.leaseToken) {
        return { kind: "lease_mismatch" };
      }

      const deadLettered = job.attemptCount >= job.maxAttempts;
      const failureClock = transaction
        .select({ now: sql<Date>`clock_timestamp()`.as("now") })
        .from(sql`(select 1) as clock_source`)
        .as("failure_clock");
      const retryAvailableAt = sql<Date>`${failureClock.now} + (${command.retryDelayMs}::bigint * interval '1 millisecond')`;
      const [failed] = await transaction
        .update(deploymentJobs)
        .set({
          availableAt: deadLettered ? sql<Date>`${failureClock.now}` : retryAvailableAt,
          deadLetteredAt: deadLettered ? sql<Date>`${failureClock.now}` : null,
          heartbeatAt: null,
          lastErrorCode: command.safeErrorCode,
          lastErrorMessage: command.safeErrorMessage,
          leaseExpiresAt: null,
          leaseToken: null,
          status: deadLettered ? "dead_lettered" : "retry_wait",
          updatedAt: sql<Date>`${failureClock.now}`,
          workerId: null,
        })
        .from(failureClock)
        .where(
          and(
            eq(deploymentJobs.id, command.workItemId),
            eq(deploymentJobs.status, "running"),
            eq(deploymentJobs.leaseToken, command.leaseToken),
            gt(deploymentJobs.leaseExpiresAt, failureClock.now),
          ),
        )
        .returning({ availableAt: deploymentJobs.availableAt });
      if (failed === undefined) {
        return { kind: "lease_expired" };
      }

      return deadLettered
        ? { attemptCount: job.attemptCount, kind: "dead_lettered" }
        : {
            attemptCount: job.attemptCount,
            availableAt: failed.availableAt,
            kind: "retry_scheduled",
          };
    });
  }

  public async recoverExpired(
    command: RecoverExpiredDeploymentJobsCommand,
  ): Promise<readonly RecoveredDeploymentJob[]> {
    assertBatchSize(command.limit);

    return this.db.transaction(async (transaction) => {
      const expired = await transaction
        .select()
        .from(deploymentJobs)
        .where(
          and(
            eq(deploymentJobs.status, "running"),
            lte(deploymentJobs.leaseExpiresAt, sql`clock_timestamp()`),
          ),
        )
        .orderBy(asc(deploymentJobs.leaseExpiresAt), asc(deploymentJobs.id))
        .limit(command.limit)
        .for("update", { skipLocked: true });

      const recovered: RecoveredDeploymentJob[] = [];
      for (const job of expired) {
        const deadLettered = job.attemptCount >= job.maxAttempts;
        const status = deadLettered ? "dead_lettered" : "retry_wait";
        const recoveryClock = transaction
          .select({ now: sql<Date>`clock_timestamp()`.as("now") })
          .from(sql`(select 1) as clock_source`)
          .as("recovery_clock");
        await transaction
          .update(deploymentJobs)
          .set({
            availableAt: sql<Date>`${recoveryClock.now}`,
            deadLetteredAt: deadLettered ? sql<Date>`${recoveryClock.now}` : null,
            heartbeatAt: null,
            lastErrorCode: "worker_lease_expired",
            lastErrorMessage: "Worker lease expired before the job completed",
            leaseExpiresAt: null,
            leaseToken: null,
            status,
            updatedAt: sql<Date>`${recoveryClock.now}`,
            workerId: null,
          })
          .from(recoveryClock)
          .where(eq(deploymentJobs.id, job.id));
        recovered.push({ id: job.id, status });
      }
      return recovered;
    });
  }

  public async recordWorkerHeartbeat(
    command: RecordWorkerHeartbeatCommand,
  ): Promise<RecordWorkerHeartbeatResult> {
    assertWorkerId(command.workerId);
    assertWorkerVersion(command.version);
    assertIntegerInRange(command.activeJobCount, "activeJobCount", 0, 10_000);
    if (command.status === "stopped" && command.activeJobCount !== 0) {
      throw new RangeError("A stopped worker cannot report active jobs");
    }

    return this.db.transaction(async (transaction) => {
      const [existing] = await transaction
        .select()
        .from(workerHeartbeats)
        .where(eq(workerHeartbeats.workerId, command.workerId))
        .for("update");

      if (existing === undefined) {
        const now = await readDatabaseClock(transaction);
        const [created] = await transaction
          .insert(workerHeartbeats)
          .values({
            activeJobCount: command.activeJobCount,
            heartbeatAt: now,
            startedAt: now,
            status: command.status,
            stoppedAt: command.status === "stopped" ? now : null,
            updatedAt: now,
            version: command.version,
            workerId: command.workerId,
          })
          .returning();
        if (created === undefined) {
          throw new Error("Worker heartbeat insert did not return a row");
        }
        return {
          kind: "created",
          worker: toWorkerSummary(created, command.status === "stopped" ? "stopped" : "fresh"),
        };
      }
      if (existing.version !== command.version) {
        return { kind: "version_mismatch" };
      }
      if (!workerTransitions[existing.status].has(command.status)) {
        return {
          currentStatus: existing.status,
          kind: "invalid_transition",
          requestedStatus: command.status,
        };
      }
      const now = await readDatabaseClock(transaction);
      const [updated] = await transaction
        .update(workerHeartbeats)
        .set({
          activeJobCount: command.activeJobCount,
          heartbeatAt: now,
          status: command.status,
          stoppedAt: command.status === "stopped" ? now : null,
          updatedAt: now,
        })
        .where(eq(workerHeartbeats.workerId, command.workerId))
        .returning();
      if (updated === undefined) {
        throw new Error("Worker heartbeat update did not return a row");
      }
      return {
        kind: "updated",
        worker: toWorkerSummary(updated, command.status === "stopped" ? "stopped" : "fresh"),
      };
    });
  }

  public async listWorkerHeartbeats(
    query: ListWorkerHeartbeatsQuery,
  ): Promise<readonly WorkerHeartbeatSummary[]> {
    assertIntegerInRange(query.staleAfterMs, "staleAfterMs", 1, maximumStaleWindowMs);

    const rows = await this.db
      .select({
        ...getTableColumns(workerHeartbeats),
        freshness: sql<WorkerHeartbeatFreshness>`case
          when ${workerHeartbeats.status} = 'stopped' then 'stopped'
          when ${workerHeartbeats.heartbeatAt} < clock_timestamp() - (${query.staleAfterMs}::bigint * interval '1 millisecond') then 'stale'
          else 'fresh'
        end`,
      })
      .from(workerHeartbeats)
      .orderBy(asc(workerHeartbeats.startedAt), asc(workerHeartbeats.workerId));
    return rows.map((row) => toWorkerSummary(row, row.freshness));
  }
}
