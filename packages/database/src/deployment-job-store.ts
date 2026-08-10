import { randomUUID } from "node:crypto";

import type {
  ClaimDeploymentJobCommand,
  ClaimDeploymentJobResult,
  CompleteDeploymentClaimTransitionCommand,
  CompleteDeploymentClaimTransitionResult,
  CompleteDeploymentSourcePreparationCommand,
  CompleteDeploymentSourcePreparationResult,
  DeploymentJobStore,
  DeploymentJobKind,
  DeploymentJobSummary,
  DeploymentSourcePreparationInput,
  DispatchableDeploymentJob,
  EnsureDeploymentClaimJobCommand,
  EnsureDeploymentClaimJobResult,
  EnsureMissingDeploymentClaimJobsCommand,
  EnsureMissingDeploymentJobsCommand,
  FailDeploymentSourcePreparationCommand,
  FailDeploymentSourcePreparationResult,
  FailDeploymentJobCommand,
  FailDeploymentJobResult,
  HeartbeatDeploymentJobCommand,
  HeartbeatDeploymentJobResult,
  ListDispatchableDeploymentJobsQuery,
  ListWorkerHeartbeatsQuery,
  LoadDeploymentSourcePreparationCommand,
  LoadDeploymentSourcePreparationResult,
  LeaseMutationFailure,
  PreparedDeploymentSourceMetadata,
  PreparedDeploymentSourceSummary,
  RecordWorkerHeartbeatCommand,
  RecordWorkerHeartbeatResult,
  RecoverExpiredDeploymentJobsCommand,
  RecoveredDeploymentJob,
  WorkerHeartbeatFreshness,
  WorkerHeartbeatStatus,
  WorkerHeartbeatSummary,
} from "@launchrail/application";
import {
  createDeploymentClaimTransitionIdempotencyKey,
  createDeploymentSourceFailureIdempotencyKey,
  createDeploymentSourceTransitionIdempotencyKey,
} from "@launchrail/contracts";
import { and, asc, eq, getTableColumns, gt, inArray, lte, notExists, or, sql } from "drizzle-orm";

import type { LaunchRailDatabase } from "./client.js";
import { transitionDeploymentInTransaction } from "./deployment-transition-store.js";
import {
  deploymentJobs,
  deploymentSourcePreparations,
  deployments,
  workerHeartbeats,
} from "./schema.js";

const deploymentClaimJobKind = "deployment.claim" as const;
const deploymentPrepareSourceJobKind = "deployment.prepare_source" as const;
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

class AtomicLeaseFailure extends Error {
  public constructor(readonly result: LeaseMutationFailure) {
    super(`Atomic deployment job mutation failed: ${result.kind}`);
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

function assertDeploymentJobKind(value: string): DeploymentJobKind {
  if (value === deploymentClaimJobKind || value === deploymentPrepareSourceJobKind) {
    return value;
  }
  throw new Error("PostgreSQL returned an unsupported deployment job kind");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const gitObjectIdPattern = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const repositoryOwnerPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const repositoryNamePattern = /^[A-Za-z0-9._-]{1,100}$/;
const requestedRevisionPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;
const dockerfilePathPattern = /^[A-Za-z0-9._/-]+$/;
const checkoutIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const resolvedDockerfilePathMaximumBytes = 1_024;

function hasSafeRelativePathShape(value: string): boolean {
  const segments = value.split("/");
  return (
    value.length >= 1 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !controlCharacterPattern.test(value) &&
    segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
  );
}

function isSafeConfiguredDockerfilePath(value: string): boolean {
  return (
    value.length <= 256 && dockerfilePathPattern.test(value) && hasSafeRelativePathShape(value)
  );
}

function isSafeResolvedDockerfilePath(value: string): boolean {
  return (
    Buffer.byteLength(value, "utf8") <= resolvedDockerfilePathMaximumBytes &&
    hasSafeRelativePathShape(value)
  );
}

function parseSourcePreparationInput(
  job: DeploymentJobRow,
  deployment: typeof deployments.$inferSelect,
): DeploymentSourcePreparationInput | undefined {
  const snapshot = deployment.sourceSnapshot;
  if (!isRecord(snapshot)) {
    return undefined;
  }
  const repositoryProvider = snapshot.repositoryProvider;
  const repositoryOwner = snapshot.repositoryOwner;
  const repositoryName = snapshot.repositoryName;
  const requestedRevision = snapshot.requestedRevision;
  const dockerfilePath = snapshot.dockerfilePath;
  if (
    snapshot.contractVersion !== 1 ||
    repositoryProvider !== "github" ||
    typeof repositoryOwner !== "string" ||
    !repositoryOwnerPattern.test(repositoryOwner) ||
    repositoryOwner.includes("--") ||
    typeof repositoryName !== "string" ||
    !repositoryNamePattern.test(repositoryName) ||
    repositoryName === "." ||
    repositoryName === ".." ||
    repositoryName.toLowerCase().endsWith(".git") ||
    typeof requestedRevision !== "string" ||
    !requestedRevisionPattern.test(requestedRevision) ||
    requestedRevision.includes("..") ||
    requestedRevision.includes("//") ||
    requestedRevision.endsWith(".") ||
    requestedRevision === "@" ||
    requestedRevision
      .split("/")
      .some(
        (segment) =>
          segment.length === 0 ||
          segment === "." ||
          segment === ".." ||
          segment.startsWith(".") ||
          segment.toLowerCase().endsWith(".lock"),
      ) ||
    typeof dockerfilePath !== "string" ||
    !isSafeConfiguredDockerfilePath(dockerfilePath) ||
    !gitObjectIdPattern.test(deployment.sourceRevision)
  ) {
    return undefined;
  }
  return {
    deploymentId: deployment.id,
    dockerfilePath,
    organizationId: deployment.organizationId,
    repositoryName,
    repositoryOwner,
    repositoryProvider,
    requestedRevision,
    resolvedRevision: deployment.sourceRevision,
    workItemId: job.id,
  };
}

function assertPreparedSourceMetadata(metadata: PreparedDeploymentSourceMetadata): void {
  if (!checkoutIdPattern.test(metadata.checkoutId)) {
    throw new RangeError("checkoutId must be a bounded opaque identifier");
  }
  if (!gitObjectIdPattern.test(metadata.resolvedRevision)) {
    throw new RangeError("resolvedRevision must be a lowercase full Git object ID");
  }
  if (!gitObjectIdPattern.test(metadata.treeRevision)) {
    throw new RangeError("treeRevision must be a lowercase full Git object ID");
  }
  assertIntegerInRange(metadata.fileCount, "fileCount", 1, 1_000_000);
  assertIntegerInRange(metadata.totalBytes, "totalBytes", 1, 1_000_000_000_000);
  if (!isSafeConfiguredDockerfilePath(metadata.dockerfilePath)) {
    throw new RangeError("dockerfilePath must be a safe relative path");
  }
  if (!isSafeResolvedDockerfilePath(metadata.dockerfileResolvedPath)) {
    throw new RangeError("dockerfileResolvedPath must be a safe relative path");
  }
  if (!sha256Pattern.test(metadata.dockerfileSha256)) {
    throw new RangeError("dockerfileSha256 must be a lowercase SHA-256 digest");
  }
}

function assertSourcePreparationFailure(command: FailDeploymentSourcePreparationCommand): void {
  assertIntegerInRange(command.retryDelayMs, "retryDelayMs", 0, maximumRetryDelayMs);
  assertSafeFailure(command.failure.category, command.failure.message);
  if (
    command.failure.category !== "clone_timeout" &&
    command.failure.category !== "dockerfile_missing" &&
    command.failure.category !== "infrastructure_unavailable" &&
    command.failure.category !== "source_invalid" &&
    command.failure.category !== "source_unavailable"
  ) {
    throw new RangeError("failure category is not valid for source preparation");
  }
}

function toPreparedSourceSummary(
  row: typeof deploymentSourcePreparations.$inferSelect,
): PreparedDeploymentSourceSummary {
  return {
    checkoutId: row.checkoutId,
    deploymentId: row.deploymentId,
    dockerfilePath: row.dockerfilePath,
    dockerfileResolvedPath: row.dockerfileResolvedPath,
    dockerfileSha256: row.dockerfileSha256,
    fileCount: row.fileCount,
    organizationId: row.organizationId,
    preparedAt: row.preparedAt,
    resolvedRevision: row.resolvedRevision,
    totalBytes: row.totalBytes,
    treeRevision: row.treeRevision,
  };
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
    kind: assertDeploymentJobKind(row.kind),
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
  readonly afterInitialSourceLeaseValidation?: () => Promise<void>;
  readonly generateLeaseToken?: () => string;
}

export class PostgresDeploymentJobStore implements DeploymentJobStore {
  private readonly afterInitialClaimLeaseValidation: () => Promise<void>;
  private readonly afterInitialSourceLeaseValidation: () => Promise<void>;
  private readonly generateLeaseToken: () => string;

  public constructor(
    private readonly db: LaunchRailDatabase,
    {
      afterInitialClaimLeaseValidation = () => Promise.resolve(),
      afterInitialSourceLeaseValidation = () => Promise.resolve(),
      generateLeaseToken = randomUUID,
    }: PostgresDeploymentJobStoreOptions = {},
  ) {
    this.afterInitialClaimLeaseValidation = afterInitialClaimLeaseValidation;
    this.afterInitialSourceLeaseValidation = afterInitialSourceLeaseValidation;
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
            eq(deploymentJobs.kind, deploymentClaimJobKind),
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
            eq(deploymentJobs.kind, deploymentClaimJobKind),
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
          kind: deploymentClaimJobKind,
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
            eq(deploymentJobs.kind, deploymentClaimJobKind),
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
                    eq(deploymentJobs.kind, deploymentClaimJobKind),
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
            kind: deploymentClaimJobKind,
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

  public async ensureMissing(
    command: EnsureMissingDeploymentJobsCommand,
  ): Promise<readonly DeploymentJobSummary[]> {
    assertBatchSize(command.limit);
    assertMaxAttempts(command.maxAttempts);

    return this.db.transaction(async (transaction) => {
      const candidates = await transaction
        .select({
          id: deployments.id,
          organizationId: deployments.organizationId,
          state: deployments.state,
        })
        .from(deployments)
        .where(
          or(
            and(
              eq(deployments.state, "queued"),
              notExists(
                transaction
                  .select({ id: deploymentJobs.id })
                  .from(deploymentJobs)
                  .where(
                    and(
                      eq(deploymentJobs.deploymentId, deployments.id),
                      eq(deploymentJobs.kind, deploymentClaimJobKind),
                    ),
                  ),
              ),
            ),
            and(
              eq(deployments.state, "cloning"),
              notExists(
                transaction
                  .select({ id: deploymentJobs.id })
                  .from(deploymentJobs)
                  .where(
                    and(
                      eq(deploymentJobs.deploymentId, deployments.id),
                      eq(deploymentJobs.kind, deploymentPrepareSourceJobKind),
                    ),
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
            kind:
              candidate.state === "queued"
                ? deploymentClaimJobKind
                : deploymentPrepareSourceJobKind,
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
          kind: assertDeploymentJobKind(row.kind),
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
      const actualKind = assertDeploymentJobKind(job.kind);
      if (actualKind !== command.expectedKind) {
        return { actualKind, kind: "kind_mismatch" };
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

      const eligibleState = actualKind === deploymentClaimJobKind ? "queued" : "cloning";
      if (deployment.state !== eligibleState) {
        if (actualKind === deploymentPrepareSourceJobKind && deployment.state === "queued") {
          return { kind: "state_mismatch", state: deployment.state };
        }
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
        if (actualKind === deploymentPrepareSourceJobKind && deployment.state === "cloning") {
          await transitionDeploymentInTransaction(transaction, {
            deploymentId: job.deploymentId,
            failure: {
              category: "infrastructure_unavailable",
              message: "Source preparation stopped before it could complete",
            },
            idempotencyKey: createDeploymentSourceFailureIdempotencyKey(job.id),
            organizationId: job.organizationId,
            to: "build_failed",
          });
        }
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
          kind: actualKind,
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
        const actualKind = assertDeploymentJobKind(job.kind);
        if (actualKind !== deploymentClaimJobKind) {
          return { actualKind, kind: "kind_mismatch" };
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

        await transaction
          .insert(deploymentJobs)
          .values({
            availableAt: sql<Date>`clock_timestamp()`,
            contractVersion: deploymentJobContractVersion,
            deploymentId: job.deploymentId,
            kind: deploymentPrepareSourceJobKind,
            maxAttempts: job.maxAttempts,
            organizationId: job.organizationId,
          })
          .onConflictDoNothing({
            target: [deploymentJobs.deploymentId, deploymentJobs.kind],
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
          throw new AtomicLeaseFailure(finalFailure);
        }

        return { kind: "completed", transition };
      });
    } catch (error) {
      if (error instanceof AtomicLeaseFailure) {
        return error.result;
      }
      throw error;
    }
  }

  public async loadSourcePreparation(
    command: LoadDeploymentSourcePreparationCommand,
  ): Promise<LoadDeploymentSourcePreparationResult> {
    return this.db.transaction(async (transaction) => {
      const [job] = await transaction
        .select()
        .from(deploymentJobs)
        .where(eq(deploymentJobs.id, command.workItemId))
        .for("update");
      if (job === undefined) {
        return { kind: "not_found" };
      }
      const actualKind = assertDeploymentJobKind(job.kind);
      if (actualKind !== deploymentPrepareSourceJobKind) {
        return { actualKind, kind: "kind_mismatch" };
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

      const [deployment] = await transaction
        .select()
        .from(deployments)
        .where(
          and(
            eq(deployments.id, job.deploymentId),
            eq(deployments.organizationId, job.organizationId),
          ),
        );
      if (deployment === undefined) {
        return { kind: "not_found" };
      }
      const source = parseSourcePreparationInput(job, deployment);
      return source === undefined
        ? { kind: "invalid_source_snapshot" }
        : { kind: "loaded", source };
    });
  }

  public async completeSourcePreparation(
    command: CompleteDeploymentSourcePreparationCommand,
  ): Promise<CompleteDeploymentSourcePreparationResult> {
    assertPreparedSourceMetadata(command.metadata);

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
        const actualKind = assertDeploymentJobKind(job.kind);
        if (actualKind !== deploymentPrepareSourceJobKind) {
          return { actualKind, kind: "kind_mismatch" };
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
        await this.afterInitialSourceLeaseValidation();

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
        const sourceInput = parseSourcePreparationInput(job, deployment);
        if (
          sourceInput === undefined ||
          command.metadata.resolvedRevision !== sourceInput.resolvedRevision ||
          command.metadata.dockerfilePath !== sourceInput.dockerfilePath
        ) {
          return { kind: "source_mismatch" };
        }

        const [existing] = await transaction
          .select()
          .from(deploymentSourcePreparations)
          .where(eq(deploymentSourcePreparations.deploymentId, deployment.id))
          .for("update");
        let preparedSource: PreparedDeploymentSourceSummary;
        if (existing !== undefined) {
          preparedSource = toPreparedSourceSummary(existing);
          if (
            preparedSource.checkoutId !== command.metadata.checkoutId ||
            preparedSource.resolvedRevision !== command.metadata.resolvedRevision ||
            preparedSource.treeRevision !== command.metadata.treeRevision ||
            preparedSource.fileCount !== command.metadata.fileCount ||
            preparedSource.totalBytes !== command.metadata.totalBytes ||
            preparedSource.dockerfilePath !== command.metadata.dockerfilePath ||
            preparedSource.dockerfileResolvedPath !== command.metadata.dockerfileResolvedPath ||
            preparedSource.dockerfileSha256 !== command.metadata.dockerfileSha256
          ) {
            return { kind: "source_mismatch" };
          }
        } else {
          const [created] = await transaction
            .insert(deploymentSourcePreparations)
            .values({
              checkoutId: command.metadata.checkoutId,
              deploymentId: deployment.id,
              dockerfilePath: command.metadata.dockerfilePath,
              dockerfileResolvedPath: command.metadata.dockerfileResolvedPath,
              dockerfileSha256: command.metadata.dockerfileSha256,
              fileCount: command.metadata.fileCount,
              organizationId: deployment.organizationId,
              preparedAt: sql<Date>`clock_timestamp()`,
              resolvedRevision: command.metadata.resolvedRevision,
              totalBytes: command.metadata.totalBytes,
              treeRevision: command.metadata.treeRevision,
            })
            .returning();
          if (created === undefined) {
            throw new Error("Prepared deployment source insert returned no row");
          }
          preparedSource = toPreparedSourceSummary(created);
        }

        const transition = await transitionDeploymentInTransaction(transaction, {
          deploymentId: deployment.id,
          idempotencyKey: createDeploymentSourceTransitionIdempotencyKey(job.id),
          organizationId: deployment.organizationId,
          to: "building",
        });

        const completionClock = transaction
          .select({ now: sql<Date>`clock_timestamp()`.as("now") })
          .from(sql`(select 1) as clock_source`)
          .as("source_completion_clock");
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
          throw new AtomicLeaseFailure({ kind: "lease_expired" });
        }

        return { kind: "completed", source: preparedSource, transition };
      });
    } catch (error) {
      if (error instanceof AtomicLeaseFailure) {
        return error.result;
      }
      throw error;
    }
  }

  public async failSourcePreparation(
    command: FailDeploymentSourcePreparationCommand,
  ): Promise<FailDeploymentSourcePreparationResult> {
    assertSourcePreparationFailure(command);

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
        const actualKind = assertDeploymentJobKind(job.kind);
        if (actualKind !== deploymentPrepareSourceJobKind) {
          return { actualKind, kind: "kind_mismatch" };
        }
        if (job.status !== "running") {
          return { kind: "not_running", status: job.status };
        }
        if (job.leaseToken !== command.leaseToken) {
          return { kind: "lease_mismatch" };
        }

        const terminal = !command.retryable || job.attemptCount >= job.maxAttempts;
        const failureClock = transaction
          .select({ now: sql<Date>`clock_timestamp()`.as("now") })
          .from(sql`(select 1) as clock_source`)
          .as("source_failure_clock");
        if (!terminal) {
          const [failed] = await transaction
            .update(deploymentJobs)
            .set({
              availableAt: sql<Date>`${failureClock.now} + (${command.retryDelayMs}::bigint * interval '1 millisecond')`,
              deadLetteredAt: null,
              heartbeatAt: null,
              lastErrorCode: command.failure.category,
              lastErrorMessage: command.failure.message,
              leaseExpiresAt: null,
              leaseToken: null,
              status: "retry_wait",
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
          return failed === undefined
            ? { kind: "lease_expired" }
            : {
                attemptCount: job.attemptCount,
                availableAt: failed.availableAt,
                kind: "retry_scheduled",
              };
        }

        const transition = await transitionDeploymentInTransaction(transaction, {
          deploymentId: job.deploymentId,
          failure: command.failure,
          idempotencyKey: createDeploymentSourceFailureIdempotencyKey(job.id),
          organizationId: job.organizationId,
          to: "build_failed",
        });
        const [deadLettered] = await transaction
          .update(deploymentJobs)
          .set({
            availableAt: sql<Date>`${failureClock.now}`,
            deadLetteredAt: sql<Date>`${failureClock.now}`,
            heartbeatAt: null,
            lastErrorCode: command.failure.category,
            lastErrorMessage: command.failure.message,
            leaseExpiresAt: null,
            leaseToken: null,
            status: "dead_lettered",
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
          .returning({ id: deploymentJobs.id });
        if (deadLettered === undefined) {
          throw new AtomicLeaseFailure({ kind: "lease_expired" });
        }
        return { attemptCount: job.attemptCount, kind: "dead_lettered", transition };
      });
    } catch (error) {
      if (error instanceof AtomicLeaseFailure) {
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
        if (deadLettered && assertDeploymentJobKind(job.kind) === deploymentPrepareSourceJobKind) {
          const [deployment] = await transaction
            .select({ state: deployments.state })
            .from(deployments)
            .where(
              and(
                eq(deployments.id, job.deploymentId),
                eq(deployments.organizationId, job.organizationId),
              ),
            );
          if (deployment?.state === "cloning") {
            await transitionDeploymentInTransaction(transaction, {
              deploymentId: job.deploymentId,
              failure: {
                category: "infrastructure_unavailable",
                message: "Source preparation stopped before it could complete",
              },
              idempotencyKey: createDeploymentSourceFailureIdempotencyKey(job.id),
              organizationId: job.organizationId,
              to: "build_failed",
            });
          }
        }
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
