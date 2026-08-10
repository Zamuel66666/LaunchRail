import type {
  DeploymentJobLease,
  DeploymentJobStore,
  FailDeploymentSourcePreparationCommand,
  SourcePreparationFailureCategory,
} from "@launchrail/application";
import { SourcePreparationError, type PrepareRepository } from "@launchrail/application";
import type { DeploymentPrepareSourceJob } from "@launchrail/contracts";
import { computeDeploymentJobBackoffMs } from "@launchrail/queue";

import type { DeploymentJobProcessingOutcome, WorkerEventLogger } from "./processor.js";

export interface DeploymentSourceProcessorOptions {
  readonly backoffBaseMs: number;
  readonly backoffCapMs: number;
  readonly heartbeatIntervalMs: number;
  readonly jobTimeoutMs: number;
  readonly leaseDurationMs: number;
  readonly logger: WorkerEventLogger;
  readonly prepareRepository: PrepareRepository;
  readonly store: DeploymentJobStore;
  readonly workerId: string;
}

interface SafeSourceFailure {
  readonly category: SourcePreparationFailureCategory;
  readonly message: string;
  readonly retryable: boolean;
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("Operation aborted");
}

async function runWithSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    throw abortError(signal);
  }

  let removeListener = (): void => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = (): void => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    removeListener = () => signal.removeEventListener("abort", onAbort);
  });

  try {
    return await Promise.race([operation, aborted]);
  } finally {
    removeListener();
  }
}

function safeSourceFailure(error: unknown): SafeSourceFailure {
  if (!(error instanceof SourcePreparationError)) {
    return {
      category: "infrastructure_unavailable",
      message: "Repository preparation could not complete and is safe to retry",
      retryable: true,
    };
  }

  switch (error.code) {
    case "repository_unavailable":
    case "checkout_failed":
      return {
        category: "source_unavailable",
        message: "The public repository is temporarily unavailable",
        retryable: error.retryable,
      };
    case "checkout_timeout":
      return {
        category: "clone_timeout",
        message: "Repository preparation exceeded its time limit",
        retryable: error.retryable,
      };
    case "dockerfile_missing":
      return {
        category: "dockerfile_missing",
        message: "The configured Dockerfile was not found in the repository",
        retryable: false,
      };
    case "dockerfile_unsafe":
    case "repository_invalid":
    case "revision_invalid":
    case "source_integrity_failed":
    case "source_limit_exceeded":
      return {
        category: "source_invalid",
        message: "Repository source is invalid or exceeds the configured safety policy",
        retryable: false,
      };
  }
}

export class DeploymentSourceProcessor {
  private activeJobCount = 0;
  private readonly backoffBaseMs: number;
  private readonly backoffCapMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly idleWaiters = new Set<() => void>();
  private readonly jobTimeoutMs: number;
  private readonly leaseDurationMs: number;
  private readonly logger: WorkerEventLogger;
  private readonly prepareRepository: PrepareRepository;
  private readonly store: DeploymentJobStore;
  private readonly workerId: string;

  public constructor({
    backoffBaseMs,
    backoffCapMs,
    heartbeatIntervalMs,
    jobTimeoutMs,
    leaseDurationMs,
    logger,
    prepareRepository,
    store,
    workerId,
  }: DeploymentSourceProcessorOptions) {
    this.backoffBaseMs = backoffBaseMs;
    this.backoffCapMs = backoffCapMs;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.jobTimeoutMs = jobTimeoutMs;
    this.leaseDurationMs = leaseDurationMs;
    this.logger = logger;
    this.prepareRepository = prepareRepository;
    this.store = store;
    this.workerId = workerId;
  }

  public getActiveJobCount(): number {
    return this.activeJobCount;
  }

  public waitForIdle(): Promise<void> {
    if (this.activeJobCount === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  private setActiveJobCount(value: number): void {
    this.activeJobCount = value;
    if (value === 0) {
      for (const resolve of this.idleWaiters) {
        resolve();
      }
      this.idleWaiters.clear();
    }
  }

  private retainActiveCountUntilSettled(operation: Promise<unknown>): void {
    this.setActiveJobCount(this.activeJobCount + 1);
    void operation.then(
      () => this.setActiveJobCount(this.activeJobCount - 1),
      () => this.setActiveJobCount(this.activeJobCount - 1),
    );
  }

  private startLeaseHeartbeat(
    lease: DeploymentJobLease,
    leaseLostController: AbortController,
  ): () => Promise<void> {
    let stopped = false;
    let heartbeatInFlight = false;
    let inFlight = Promise.resolve();
    const heartbeat = (): void => {
      if (stopped || heartbeatInFlight) {
        return;
      }
      heartbeatInFlight = true;
      inFlight = this.store
        .heartbeat({
          leaseDurationMs: this.leaseDurationMs,
          leaseToken: lease.leaseToken,
          workItemId: lease.workItemId,
        })
        .then((result) => {
          if (result.kind !== "extended") {
            leaseLostController.abort(new Error("Deployment source job lease was lost"));
          }
        })
        .catch(() => {
          leaseLostController.abort(new Error("Deployment source job heartbeat failed"));
        })
        .finally(() => {
          heartbeatInFlight = false;
        });
    };
    const timer = setInterval(heartbeat, this.heartbeatIntervalMs);
    timer.unref();

    return async () => {
      stopped = true;
      clearInterval(timer);
      await inFlight;
    };
  }

  public async process(
    job: DeploymentPrepareSourceJob,
    shutdownSignal: AbortSignal,
  ): Promise<DeploymentJobProcessingOutcome> {
    if (shutdownSignal.aborted) {
      return "interrupted";
    }

    const timeoutSignal = AbortSignal.timeout(this.jobTimeoutMs);
    const attemptSignal = AbortSignal.any([shutdownSignal, timeoutSignal]);
    let claimSettled = false;
    const claimOperation = this.store.claim({
      expectedKind: job.kind,
      leaseDurationMs: this.leaseDurationMs,
      workerId: this.workerId,
      workItemId: job.workItemId,
    });
    void claimOperation.then(
      () => {
        claimSettled = true;
      },
      () => {
        claimSettled = true;
      },
    );

    let claim;
    try {
      claim = await runWithSignal(claimOperation, attemptSignal);
    } catch {
      if (!claimSettled) {
        this.retainActiveCountUntilSettled(claimOperation);
      }
      if (shutdownSignal.aborted) {
        return "interrupted";
      }
      this.logger.error(
        {
          event: timeoutSignal.aborted
            ? "deployment_source_job_claim_timed_out"
            : "deployment_source_job_claim_failed",
          workItemId: job.workItemId,
        },
        "Deployment source job claim could not reach authoritative storage",
      );
      return "infrastructure_unavailable";
    }

    if (claim.kind === "completed" || claim.kind === "dead_lettered") {
      return "terminal";
    }
    if (claim.kind !== "claimed") {
      return "lease_unavailable";
    }

    const lease = claim.lease;
    const leaseLostController = new AbortController();
    const effectiveSignal = AbortSignal.any([
      shutdownSignal,
      timeoutSignal,
      leaseLostController.signal,
    ]);
    const stopHeartbeat = this.startLeaseHeartbeat(lease, leaseLostController);
    const unsettledOperations = new Set<Promise<unknown>>();
    const trackOperation = <T>(operation: Promise<T>): Promise<T> => {
      unsettledOperations.add(operation);
      void operation.then(
        () => unsettledOperations.delete(operation),
        () => unsettledOperations.delete(operation),
      );
      return operation;
    };
    let heartbeatStopPromise: Promise<void> | undefined;
    const stopHeartbeatOnce = (): Promise<void> => {
      heartbeatStopPromise ??= stopHeartbeat();
      return heartbeatStopPromise;
    };
    this.setActiveJobCount(this.activeJobCount + 1);
    let failurePersistenceStarted = false;

    const persistFailure = async (
      sourceFailure: SafeSourceFailure,
    ): Promise<DeploymentJobProcessingOutcome> => {
      try {
        await runWithSignal(stopHeartbeatOnce(), attemptSignal);
      } catch {
        // An interrupted heartbeat leaves the lease recoverable.
      }
      if (effectiveSignal.aborted) {
        return "interrupted";
      }

      const retryDelayMs = computeDeploymentJobBackoffMs({
        attempt: lease.attemptCount,
        baseDelayMs: this.backoffBaseMs,
        maxDelayMs: this.backoffCapMs,
        workItemId: lease.workItemId,
      });
      const failureCommand: FailDeploymentSourcePreparationCommand = {
        failure: { category: sourceFailure.category, message: sourceFailure.message },
        leaseToken: lease.leaseToken,
        retryable: sourceFailure.retryable,
        retryDelayMs,
        workItemId: lease.workItemId,
      };
      failurePersistenceStarted = true;
      const persisted = await runWithSignal(
        trackOperation(this.store.failSourcePreparation(failureCommand)),
        attemptSignal,
      );
      if (persisted.kind === "retry_scheduled") {
        this.logger.warn(
          {
            attempt: persisted.attemptCount,
            availableAt: persisted.availableAt.toISOString(),
            event: "deployment_source_retry_scheduled",
            failureCategory: sourceFailure.category,
            workItemId: lease.workItemId,
          },
          "Deployment source preparation retry was persisted",
        );
        return "retry_scheduled";
      }
      if (persisted.kind === "dead_lettered") {
        this.logger.error(
          {
            attempt: persisted.attemptCount,
            event: "deployment_source_dead_lettered",
            failureCategory: sourceFailure.category,
            workItemId: lease.workItemId,
          },
          "Deployment source preparation reached a terminal failure",
        );
        return "dead_lettered";
      }
      return "interrupted";
    };

    let failure: SafeSourceFailure | undefined;
    try {
      const loaded = await runWithSignal(
        trackOperation(
          this.store.loadSourcePreparation({
            leaseToken: lease.leaseToken,
            workItemId: lease.workItemId,
          }),
        ),
        effectiveSignal,
      );
      if (loaded.kind === "invalid_source_snapshot") {
        failure = {
          category: "source_invalid",
          message: "Deployment source metadata is invalid or unsupported",
          retryable: false,
        };
      } else if (loaded.kind !== "loaded") {
        this.logger.warn(
          {
            event: "deployment_source_job_load_fenced",
            outcome: loaded.kind,
            workItemId: lease.workItemId,
          },
          "Deployment source job load was rejected by its lease",
        );
        return "interrupted";
      } else {
        let prepared;
        try {
          prepared = await runWithSignal(
            trackOperation(
              this.prepareRepository.execute({
                checkoutKey: loaded.source.deploymentId,
                dockerfilePath: loaded.source.dockerfilePath,
                repository: {
                  owner: loaded.source.repositoryOwner,
                  repository: loaded.source.repositoryName,
                },
                revision: loaded.source.resolvedRevision,
                signal: effectiveSignal,
              }),
            ),
            effectiveSignal,
          );
        } catch (error) {
          if (effectiveSignal.aborted) {
            throw error;
          }
          failure = safeSourceFailure(error);
        }

        if (prepared !== undefined) {
          const completion = await runWithSignal(
            trackOperation(
              this.store.completeSourcePreparation({
                leaseToken: lease.leaseToken,
                metadata: {
                  checkoutId: prepared.checkoutKey,
                  dockerfilePath: prepared.dockerfile.relativePath,
                  dockerfileResolvedPath: prepared.dockerfile.resolvedRelativePath,
                  dockerfileSha256: prepared.dockerfile.sha256,
                  fileCount: prepared.fileCount,
                  resolvedRevision: prepared.commitSha,
                  totalBytes: prepared.totalBytes,
                  treeRevision: prepared.treeSha,
                },
                workItemId: lease.workItemId,
              }),
            ),
            effectiveSignal,
          );
          if (completion.kind === "completed") {
            try {
              await runWithSignal(stopHeartbeatOnce(), attemptSignal);
            } catch {
              // Completion is authoritative; shutdown still tracks the final heartbeat.
            }
            this.logger.info(
              {
                adopted: prepared.adopted,
                event: "deployment_source_prepared",
                fileCount: prepared.fileCount,
                totalBytes: prepared.totalBytes,
                workItemId: lease.workItemId,
              },
              "Deployment repository source was prepared",
            );
            return "completed";
          }
          if (completion.kind === "source_mismatch") {
            failure = {
              category: "source_invalid",
              message: "Prepared repository metadata did not match deployment intent",
              retryable: false,
            };
          } else {
            this.logger.warn(
              {
                event: "deployment_source_job_completion_fenced",
                outcome: completion.kind,
                workItemId: lease.workItemId,
              },
              "Deployment source job completion was rejected by its lease",
            );
            return "interrupted";
          }
        }
      }

      if (failure === undefined) {
        throw new Error("Deployment source processing ended without an outcome");
      }
      return await persistFailure(failure);
    } catch (error) {
      try {
        await runWithSignal(stopHeartbeatOnce(), attemptSignal);
      } catch {
        // Active operation tracking holds shutdown until the mutation settles.
      }
      if (effectiveSignal.aborted) {
        this.logger.warn(
          { event: "deployment_source_job_interrupted", workItemId: lease.workItemId },
          "Deployment source job stopped with a recoverable lease",
        );
        return "interrupted";
      }
      if (!failurePersistenceStarted) {
        try {
          return await persistFailure(safeSourceFailure(error));
        } catch {
          // The safe failure write is reported below without exposing either error.
        }
      }
      this.logger.error(
        {
          event: "deployment_source_failure_persistence_failed",
          workItemId: lease.workItemId,
        },
        "Deployment source failure could not reach authoritative storage",
      );
      return "interrupted";
    } finally {
      const heartbeatSettlement = stopHeartbeatOnce();
      const trailingSettlement = Promise.allSettled([...unsettledOperations, heartbeatSettlement]);
      if (!effectiveSignal.aborted) {
        await trailingSettlement;
        this.setActiveJobCount(this.activeJobCount - 1);
      } else {
        void trailingSettlement.then(() => {
          this.setActiveJobCount(this.activeJobCount - 1);
        });
      }
    }
  }
}
