import type { DeploymentFailureCategory, DeploymentState, ProjectRuntimeConfig } from "@launchrail/domain";

import type { DeploymentTransitionResult } from "./deployments.js";

export const deploymentJobStatuses = [
  "pending",
  "running",
  "retry_wait",
  "completed",
  "dead_lettered",
] as const;

export type DeploymentJobStatus = (typeof deploymentJobStatuses)[number];

export const deploymentJobKinds = [
  "deployment.claim",
  "deployment.prepare_source",
  "deployment.build",
  "deployment.start_runtime",
] as const;

export type DeploymentJobKind = (typeof deploymentJobKinds)[number];

export const workerHeartbeatStatuses = ["starting", "ready", "draining", "stopped"] as const;

export type WorkerHeartbeatStatus = (typeof workerHeartbeatStatuses)[number];

export interface DeploymentJobSummary {
  readonly attemptCount: number;
  readonly availableAt: Date;
  readonly completedAt: Date | null;
  readonly contractVersion: number;
  readonly createdAt: Date;
  readonly deadLetteredAt: Date | null;
  readonly deploymentId: string;
  readonly heartbeatAt: Date | null;
  readonly id: string;
  readonly kind: DeploymentJobKind;
  readonly lastErrorCode: string | null;
  readonly lastErrorMessage: string | null;
  readonly leaseExpiresAt: Date | null;
  readonly leaseToken: string | null;
  readonly maxAttempts: number;
  readonly organizationId: string;
  readonly status: DeploymentJobStatus;
  readonly updatedAt: Date;
  readonly workerId: string | null;
}

export interface EnsureDeploymentClaimJobCommand {
  readonly availableAt: Date;
  readonly deploymentId: string;
  readonly maxAttempts: number;
  readonly organizationId: string;
}

export type EnsureDeploymentClaimJobResult =
  | { readonly job: DeploymentJobSummary; readonly kind: "created" | "existing" }
  | { readonly kind: "deployment_not_found" }
  | { readonly kind: "deployment_ineligible"; readonly state: DeploymentState };

export interface EnsureMissingDeploymentClaimJobsCommand {
  readonly limit: number;
  readonly maxAttempts: number;
}

export interface EnsureMissingDeploymentJobsCommand {
  readonly limit: number;
  readonly maxAttempts: number;
}

export interface ListDispatchableDeploymentJobsQuery {
  readonly limit: number;
}

export interface DispatchableDeploymentJob {
  readonly contractVersion: number;
  readonly id: string;
  readonly kind: DeploymentJobKind;
}

export interface ClaimDeploymentJobCommand {
  readonly expectedKind: DeploymentJobKind;
  readonly leaseDurationMs: number;
  readonly workItemId: string;
  readonly workerId: string;
}

export interface DeploymentJobLease {
  readonly attemptCount: number;
  readonly deploymentId: string;
  readonly kind: DeploymentJobKind;
  readonly leaseExpiresAt: Date;
  readonly leaseToken: string;
  readonly organizationId: string;
  readonly workItemId: string;
}

export type ClaimDeploymentJobResult =
  | { readonly kind: "claimed"; readonly lease: DeploymentJobLease }
  | { readonly kind: "busy"; readonly leaseExpiresAt: Date }
  | { readonly actualKind: DeploymentJobKind; readonly kind: "kind_mismatch" }
  | { readonly availableAt: Date; readonly kind: "not_due" }
  | { readonly kind: "state_mismatch"; readonly state: DeploymentState }
  | { readonly kind: "completed" | "dead_lettered" | "not_found" };

export interface HeartbeatDeploymentJobCommand {
  readonly leaseDurationMs: number;
  readonly leaseToken: string;
  readonly workItemId: string;
}

export type LeaseMutationFailure =
  | { readonly actualKind: DeploymentJobKind; readonly kind: "kind_mismatch" }
  | { readonly kind: "lease_expired" }
  | { readonly kind: "lease_mismatch" }
  | { readonly kind: "not_found" }
  | { readonly kind: "not_running"; readonly status: DeploymentJobStatus };

export type HeartbeatDeploymentJobResult =
  { readonly kind: "extended"; readonly leaseExpiresAt: Date } | LeaseMutationFailure;

export interface CompleteDeploymentClaimTransitionCommand {
  readonly leaseToken: string;
  readonly workItemId: string;
}

export type CompleteDeploymentClaimTransitionResult =
  | { readonly kind: "completed"; readonly transition: DeploymentTransitionResult }
  | LeaseMutationFailure;

export interface DeploymentSourcePreparationInput {
  readonly deploymentId: string;
  readonly dockerfilePath: string;
  readonly organizationId: string;
  readonly repositoryName: string;
  readonly repositoryOwner: string;
  readonly repositoryProvider: "github";
  readonly requestedRevision: string;
  readonly resolvedRevision: string;
  readonly workItemId: string;
}

export interface LoadDeploymentSourcePreparationCommand {
  readonly leaseToken: string;
  readonly workItemId: string;
}

export type LoadDeploymentSourcePreparationResult =
  | { readonly kind: "loaded"; readonly source: DeploymentSourcePreparationInput }
  | { readonly kind: "invalid_source_snapshot" }
  | LeaseMutationFailure;

export interface PreparedDeploymentSourceMetadata {
  readonly checkoutId: string;
  readonly contextSha256: string;
  readonly dockerfilePath: string;
  readonly dockerfileResolvedPath: string;
  readonly dockerfileSha256: string;
  readonly fileCount: number;
  readonly resolvedRevision: string;
  readonly totalBytes: number;
  readonly treeRevision: string;
}

export interface PreparedDeploymentSourceSummary extends PreparedDeploymentSourceMetadata {
  readonly deploymentId: string;
  readonly organizationId: string;
  readonly preparedAt: Date;
}

export interface CompleteDeploymentSourcePreparationCommand {
  readonly leaseToken: string;
  readonly metadata: PreparedDeploymentSourceMetadata;
  readonly workItemId: string;
}

export type CompleteDeploymentSourcePreparationResult =
  | {
      readonly kind: "completed";
      readonly source: PreparedDeploymentSourceSummary;
      readonly transition: DeploymentTransitionResult;
    }
  | { readonly kind: "source_mismatch" }
  | LeaseMutationFailure;

export const deploymentBuildLogStreams = ["stdout", "stderr", "system"] as const;

export type DeploymentBuildLogStream = (typeof deploymentBuildLogStreams)[number];

export interface DeploymentBuildInput {
  readonly checkoutId: string;
  readonly contextSha256: string;
  readonly deploymentId: string;
  readonly dockerfilePath: string;
  readonly dockerfileResolvedPath: string;
  readonly dockerfileSha256: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly resolvedRevision: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly treeRevision: string;
  readonly workItemId: string;
}

export interface LoadDeploymentBuildInputCommand {
  readonly leaseToken: string;
  readonly workItemId: string;
}

export type LoadDeploymentBuildInputResult =
  | { readonly build: DeploymentBuildInput; readonly kind: "loaded" }
  | { readonly kind: "source_not_prepared" }
  | { readonly kind: "state_mismatch"; readonly state: DeploymentState }
  | LeaseMutationFailure;

export interface DeploymentBuildLogChunk {
  readonly content: string;
  readonly stream: DeploymentBuildLogStream;
}

export interface AppendDeploymentBuildLogsCommand {
  readonly chunks: readonly DeploymentBuildLogChunk[];
  readonly leaseToken: string;
  readonly maxRetainedBytes: number;
  readonly workItemId: string;
}

export type AppendDeploymentBuildLogsResult =
  | {
      readonly acceptedBytes: number;
      readonly firstSequence: number | null;
      readonly kind: "appended";
      readonly lastSequence: number | null;
      readonly truncated: boolean;
    }
  | LeaseMutationFailure;

export interface BuiltDeploymentImageMetadata {
  readonly cacheHitCount: number;
  readonly cacheMissCount: number;
  readonly contextSha256: string;
  readonly imageId: string;
  readonly imageReference: string;
  readonly imageSizeBytes: number;
  readonly manifestDigest: string;
  readonly platform: string;
}

export interface BuiltDeploymentImageSummary extends BuiltDeploymentImageMetadata {
  readonly builtAt: Date;
  readonly checkoutId: string;
  readonly deploymentId: string;
  readonly dockerfileSha256: string;
  readonly organizationId: string;
  readonly sourceRevision: string;
  readonly treeRevision: string;
  readonly workItemId: string;
}

export interface CompleteDeploymentBuildCommand {
  readonly image: BuiltDeploymentImageMetadata;
  readonly leaseToken: string;
  readonly workItemId: string;
}

export type CompleteDeploymentBuildResult =
  | {
      readonly image: BuiltDeploymentImageSummary;
      readonly kind: "completed";
      readonly transition: DeploymentTransitionResult;
    }
  | { readonly kind: "build_mismatch" | "source_mismatch" }
  | { readonly kind: "state_mismatch"; readonly state: DeploymentState }
  | LeaseMutationFailure;

export type DeploymentBuildFailureCategory = Extract<
  DeploymentFailureCategory,
  | "build_failed"
  | "build_rejected"
  | "build_timeout"
  | "infrastructure_unavailable"
  | "internal_invariant_violation"
>;

export interface FailDeploymentBuildCommand {
  readonly failure: {
    readonly category: DeploymentBuildFailureCategory;
    readonly message: string;
  };
  readonly leaseToken: string;
  readonly retryable: boolean;
  readonly retryDelayMs: number;
  readonly workItemId: string;
}

export type FailDeploymentBuildResult =
  | {
      readonly attemptCount: number;
      readonly availableAt: Date;
      readonly kind: "retry_scheduled";
    }
  | {
      readonly attemptCount: number;
      readonly kind: "dead_lettered";
      readonly transition: DeploymentTransitionResult;
    }
  | { readonly kind: "state_mismatch"; readonly state: DeploymentState }
  | LeaseMutationFailure;

export interface DeploymentRuntimeInput {
  readonly deploymentId: string;
  readonly healthCheckPort: number;
  readonly imageId: string;
  readonly imageReference: string;
  readonly manifestDigest: string;
  readonly organizationId: string;
  readonly platform: string;
  readonly projectId: string;
  readonly runtimeConfig: ProjectRuntimeConfig;
  readonly workItemId: string;
}

export interface LoadDeploymentRuntimeInputCommand {
  readonly leaseToken: string;
  readonly workItemId: string;
}

export type LoadDeploymentRuntimeInputResult =
  | { readonly kind: "loaded"; readonly runtime: DeploymentRuntimeInput }
  | { readonly kind: "build_not_ready" }
  | { readonly kind: "state_mismatch"; readonly state: DeploymentState }
  | LeaseMutationFailure;

export interface StartedDeploymentRuntimeMetadata {
  readonly containerId: string;
  readonly hostPort: number;
  readonly imageDigest: string;
  readonly resourceMetadata: Readonly<Record<string, unknown>>;
}

export interface DeploymentRuntimeInstanceSummary extends StartedDeploymentRuntimeMetadata {
  readonly createdAt: Date;
  readonly deploymentId: string;
  readonly id: string;
  readonly organizationId: string;
}

export interface CompleteDeploymentRuntimeCommand {
  readonly leaseToken: string;
  readonly runtime: StartedDeploymentRuntimeMetadata;
  readonly workItemId: string;
}

export type CompleteDeploymentRuntimeResult =
  | { readonly kind: "completed"; readonly runtime: DeploymentRuntimeInstanceSummary; readonly transition: DeploymentTransitionResult }
  | { readonly kind: "build_mismatch" | "runtime_mismatch" }
  | { readonly kind: "state_mismatch"; readonly state: DeploymentState }
  | LeaseMutationFailure;

export type DeploymentRuntimeFailureCategory = Extract<
  DeploymentFailureCategory,
  | "runtime_policy_rejected"
  | "runtime_start_failed"
  | "runtime_timeout"
  | "infrastructure_unavailable"
  | "internal_invariant_violation"
>;

export interface FailDeploymentRuntimeCommand {
  readonly failure: { readonly category: DeploymentRuntimeFailureCategory; readonly message: string };
  readonly leaseToken: string;
  readonly retryable: boolean;
  readonly retryDelayMs: number;
  readonly workItemId: string;
}

export type FailDeploymentRuntimeResult =
  | { readonly attemptCount: number; readonly availableAt: Date; readonly kind: "retry_scheduled" }
  | { readonly attemptCount: number; readonly kind: "dead_lettered"; readonly transition: DeploymentTransitionResult }
  | { readonly kind: "state_mismatch"; readonly state: DeploymentState }
  | LeaseMutationFailure;

export type SourcePreparationFailureCategory = Extract<
  DeploymentFailureCategory,
  | "clone_timeout"
  | "dockerfile_missing"
  | "infrastructure_unavailable"
  | "source_invalid"
  | "source_unavailable"
>;

export interface FailDeploymentSourcePreparationCommand {
  readonly failure: {
    readonly category: SourcePreparationFailureCategory;
    readonly message: string;
  };
  readonly leaseToken: string;
  readonly retryable: boolean;
  readonly retryDelayMs: number;
  readonly workItemId: string;
}

export type FailDeploymentSourcePreparationResult =
  | {
      readonly attemptCount: number;
      readonly availableAt: Date;
      readonly kind: "retry_scheduled";
    }
  | {
      readonly attemptCount: number;
      readonly kind: "dead_lettered";
      readonly transition: DeploymentTransitionResult;
    }
  | LeaseMutationFailure;

export interface FailDeploymentJobCommand {
  readonly leaseToken: string;
  readonly retryDelayMs: number;
  readonly safeErrorCode: string;
  readonly safeErrorMessage: string;
  readonly workItemId: string;
}

export type FailDeploymentJobResult =
  | {
      readonly attemptCount: number;
      readonly availableAt: Date;
      readonly kind: "retry_scheduled";
    }
  | { readonly attemptCount: number; readonly kind: "dead_lettered" }
  | LeaseMutationFailure;

export interface RecoverExpiredDeploymentJobsCommand {
  readonly limit: number;
}

export interface RecoveredDeploymentJob {
  readonly id: string;
  readonly status: "retry_wait" | "dead_lettered";
}

export interface RecordWorkerHeartbeatCommand {
  readonly activeJobCount: number;
  readonly status: WorkerHeartbeatStatus;
  readonly version: string;
  readonly workerId: string;
}

export type RecordWorkerHeartbeatResult =
  | { readonly kind: "created" | "updated"; readonly worker: WorkerHeartbeatSummary }
  | {
      readonly currentStatus: WorkerHeartbeatStatus;
      readonly kind: "invalid_transition";
      readonly requestedStatus: WorkerHeartbeatStatus;
    }
  | { readonly kind: "version_mismatch" };

export type WorkerHeartbeatFreshness = "fresh" | "stale" | "stopped";

export interface WorkerHeartbeatSummary {
  readonly activeJobCount: number;
  readonly freshness: WorkerHeartbeatFreshness;
  readonly heartbeatAt: Date;
  readonly startedAt: Date;
  readonly status: WorkerHeartbeatStatus;
  readonly stoppedAt: Date | null;
  readonly version: string;
  readonly workerId: string;
}

export interface ListWorkerHeartbeatsQuery {
  readonly staleAfterMs: number;
}

export interface DeploymentJobStore {
  appendBuildLogs(
    command: AppendDeploymentBuildLogsCommand,
  ): Promise<AppendDeploymentBuildLogsResult>;
  claim(command: ClaimDeploymentJobCommand): Promise<ClaimDeploymentJobResult>;
  completeClaimTransition(
    command: CompleteDeploymentClaimTransitionCommand,
  ): Promise<CompleteDeploymentClaimTransitionResult>;
  completeBuild(command: CompleteDeploymentBuildCommand): Promise<CompleteDeploymentBuildResult>;
  completeRuntime(command: CompleteDeploymentRuntimeCommand): Promise<CompleteDeploymentRuntimeResult>;
  completeSourcePreparation(
    command: CompleteDeploymentSourcePreparationCommand,
  ): Promise<CompleteDeploymentSourcePreparationResult>;
  ensureMissing(
    command: EnsureMissingDeploymentJobsCommand,
  ): Promise<readonly DeploymentJobSummary[]>;
  ensureMissingClaims(
    command: EnsureMissingDeploymentClaimJobsCommand,
  ): Promise<readonly DeploymentJobSummary[]>;
  ensurePendingClaim(
    command: EnsureDeploymentClaimJobCommand,
  ): Promise<EnsureDeploymentClaimJobResult>;
  fail(command: FailDeploymentJobCommand): Promise<FailDeploymentJobResult>;
  failBuild(command: FailDeploymentBuildCommand): Promise<FailDeploymentBuildResult>;
  failRuntime(command: FailDeploymentRuntimeCommand): Promise<FailDeploymentRuntimeResult>;
  failSourcePreparation(
    command: FailDeploymentSourcePreparationCommand,
  ): Promise<FailDeploymentSourcePreparationResult>;
  heartbeat(command: HeartbeatDeploymentJobCommand): Promise<HeartbeatDeploymentJobResult>;
  listDispatchable(
    query: ListDispatchableDeploymentJobsQuery,
  ): Promise<readonly DispatchableDeploymentJob[]>;
  listWorkerHeartbeats(
    query: ListWorkerHeartbeatsQuery,
  ): Promise<readonly WorkerHeartbeatSummary[]>;
  recordWorkerHeartbeat(
    command: RecordWorkerHeartbeatCommand,
  ): Promise<RecordWorkerHeartbeatResult>;
  recoverExpired(
    command: RecoverExpiredDeploymentJobsCommand,
  ): Promise<readonly RecoveredDeploymentJob[]>;
  loadSourcePreparation(
    command: LoadDeploymentSourcePreparationCommand,
  ): Promise<LoadDeploymentSourcePreparationResult>;
  loadBuildInput(command: LoadDeploymentBuildInputCommand): Promise<LoadDeploymentBuildInputResult>;
  loadRuntimeInput(command: LoadDeploymentRuntimeInputCommand): Promise<LoadDeploymentRuntimeInputResult>;
}
