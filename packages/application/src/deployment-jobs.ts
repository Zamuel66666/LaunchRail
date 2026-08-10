import type { DeploymentState } from "@launchrail/domain";

import type { DeploymentTransitionResult } from "./deployments.js";

export const deploymentJobStatuses = [
  "pending",
  "running",
  "retry_wait",
  "completed",
  "dead_lettered",
] as const;

export type DeploymentJobStatus = (typeof deploymentJobStatuses)[number];

export const deploymentJobKinds = ["deployment.claim"] as const;

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

export interface ListDispatchableDeploymentJobsQuery {
  readonly limit: number;
}

export interface DispatchableDeploymentJob {
  readonly contractVersion: number;
  readonly id: string;
  readonly kind: DeploymentJobKind;
}

export interface ClaimDeploymentJobCommand {
  readonly leaseDurationMs: number;
  readonly workItemId: string;
  readonly workerId: string;
}

export interface DeploymentJobLease {
  readonly attemptCount: number;
  readonly deploymentId: string;
  readonly leaseExpiresAt: Date;
  readonly leaseToken: string;
  readonly organizationId: string;
  readonly workItemId: string;
}

export type ClaimDeploymentJobResult =
  | { readonly kind: "claimed"; readonly lease: DeploymentJobLease }
  | { readonly kind: "busy"; readonly leaseExpiresAt: Date }
  | { readonly availableAt: Date; readonly kind: "not_due" }
  | { readonly kind: "completed" | "dead_lettered" | "not_found" };

export interface HeartbeatDeploymentJobCommand {
  readonly leaseDurationMs: number;
  readonly leaseToken: string;
  readonly workItemId: string;
}

export type LeaseMutationFailure =
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
  claim(command: ClaimDeploymentJobCommand): Promise<ClaimDeploymentJobResult>;
  completeClaimTransition(
    command: CompleteDeploymentClaimTransitionCommand,
  ): Promise<CompleteDeploymentClaimTransitionResult>;
  ensureMissingClaims(
    command: EnsureMissingDeploymentClaimJobsCommand,
  ): Promise<readonly DeploymentJobSummary[]>;
  ensurePendingClaim(
    command: EnsureDeploymentClaimJobCommand,
  ): Promise<EnsureDeploymentClaimJobResult>;
  fail(command: FailDeploymentJobCommand): Promise<FailDeploymentJobResult>;
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
}
