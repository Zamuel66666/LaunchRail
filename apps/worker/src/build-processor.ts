import { join } from "node:path";

import type {
  BuildLogChunk,
  DeploymentBuildFailureCategory,
  DeploymentJobLease,
  DeploymentJobStore,
  FailDeploymentBuildCommand,
  ImageBuilder,
  RepositoryCheckout,
} from "@launchrail/application";
import { ImageBuildError } from "@launchrail/application";
import type { DeploymentBuildJob } from "@launchrail/contracts";
import { computeDeploymentJobBackoffMs } from "@launchrail/queue";

import type { DeploymentJobProcessingOutcome, WorkerEventLogger } from "./processor.js";

export interface DeploymentBuildProcessorOptions {
  readonly backoffBaseMs: number;
  readonly backoffCapMs: number;
  readonly heartbeatIntervalMs: number;
  readonly imageBuilder: ImageBuilder;
  readonly jobTimeoutMs: number;
  readonly leaseDurationMs: number;
  readonly logMaxRetainedBytes: number;
  readonly logger: WorkerEventLogger;
  readonly repositoryCheckout: RepositoryCheckout;
  readonly sourceRoot: string;
  readonly store: DeploymentJobStore;
  readonly workerId: string;
}

interface SafeBuildFailure {
  readonly category: DeploymentBuildFailureCategory;
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

function safeBuildFailure(error: unknown): SafeBuildFailure {
  if (!(error instanceof ImageBuildError)) {
    return {
      category: "infrastructure_unavailable",
      message: "The image builder is temporarily unavailable",
      retryable: true,
    };
  }

  switch (error.code) {
    case "build_context_changed":
    case "build_context_invalid":
    case "build_output_limit_exceeded":
      return {
        category: "build_rejected",
        message: "The repository build was rejected by the configured safety policy",
        retryable: false,
      };
    case "build_failed":
      return {
        category: "build_failed",
        message: "The repository image build did not complete successfully",
        retryable: false,
      };
    case "build_timeout":
      return {
        category: "build_timeout",
        message: "The image build exceeded its time limit",
        retryable: false,
      };
    case "buildkit_unavailable":
    case "image_cleanup_failed":
      return {
        category: "infrastructure_unavailable",
        message: "The image builder is temporarily unavailable",
        retryable: true,
      };
    case "image_metadata_invalid":
      return {
        category: "internal_invariant_violation",
        message: "The image builder returned an invalid or conflicting result",
        retryable: false,
      };
  }
}

export class DeploymentBuildProcessor {
  private activeJobCount = 0;
  private readonly backoffBaseMs: number;
  private readonly backoffCapMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly idleWaiters = new Set<() => void>();
  private readonly imageBuilder: ImageBuilder;
  private readonly jobTimeoutMs: number;
  private readonly leaseDurationMs: number;
  private readonly logMaxRetainedBytes: number;
  private readonly logger: WorkerEventLogger;
  private readonly repositoryCheckout: RepositoryCheckout;
  private readonly sourceRoot: string;
  private readonly store: DeploymentJobStore;
  private readonly workerId: string;

  public constructor({
    backoffBaseMs,
    backoffCapMs,
    heartbeatIntervalMs,
    imageBuilder,
    jobTimeoutMs,
    leaseDurationMs,
    logMaxRetainedBytes,
    logger,
    repositoryCheckout,
    sourceRoot,
    store,
    workerId,
  }: DeploymentBuildProcessorOptions) {
    this.backoffBaseMs = backoffBaseMs;
    this.backoffCapMs = backoffCapMs;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.imageBuilder = imageBuilder;
    this.jobTimeoutMs = jobTimeoutMs;
    this.leaseDurationMs = leaseDurationMs;
    this.logMaxRetainedBytes = logMaxRetainedBytes;
    this.logger = logger;
    this.repositoryCheckout = repositoryCheckout;
    this.sourceRoot = sourceRoot;
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
            leaseLostController.abort(new Error("Deployment build job lease was lost"));
          }
        })
        .catch(() => {
          leaseLostController.abort(new Error("Deployment build job heartbeat failed"));
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
    job: DeploymentBuildJob,
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
            ? "deployment_build_job_claim_timed_out"
            : "deployment_build_job_claim_failed",
          workItemId: job.workItemId,
        },
        "Deployment build job claim could not reach authoritative storage",
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
    let checkoutId: string | undefined;

    const cleanupCheckout = async (): Promise<void> => {
      if (checkoutId === undefined) {
        return;
      }
      try {
        await trackOperation(this.repositoryCheckout.remove(checkoutId));
      } catch {
        this.logger.warn(
          { event: "deployment_build_checkout_cleanup_failed", workItemId: lease.workItemId },
          "A consumed source checkout remains for a later cleanup pass",
        );
      }
    };

    const persistFailure = async (
      buildFailure: SafeBuildFailure,
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
      const failureCommand: FailDeploymentBuildCommand = {
        failure: { category: buildFailure.category, message: buildFailure.message },
        leaseToken: lease.leaseToken,
        retryable: buildFailure.retryable,
        retryDelayMs,
        workItemId: lease.workItemId,
      };
      failurePersistenceStarted = true;
      const persisted = await runWithSignal(
        trackOperation(this.store.failBuild(failureCommand)),
        attemptSignal,
      );
      if (persisted.kind === "retry_scheduled") {
        this.logger.warn(
          {
            attempt: persisted.attemptCount,
            availableAt: persisted.availableAt.toISOString(),
            event: "deployment_build_retry_scheduled",
            failureCategory: buildFailure.category,
            workItemId: lease.workItemId,
          },
          "Deployment image build retry was persisted",
        );
        return "retry_scheduled";
      }
      if (persisted.kind === "dead_lettered") {
        await cleanupCheckout();
        this.logger.error(
          {
            attempt: persisted.attemptCount,
            event: "deployment_build_dead_lettered",
            failureCategory: buildFailure.category,
            workItemId: lease.workItemId,
          },
          "Deployment image build reached a terminal failure",
        );
        return "dead_lettered";
      }
      return "interrupted";
    };

    let failure: SafeBuildFailure | undefined;
    try {
      const loaded = await runWithSignal(
        trackOperation(
          this.store.loadBuildInput({
            leaseToken: lease.leaseToken,
            workItemId: lease.workItemId,
          }),
        ),
        effectiveSignal,
      );
      if (loaded.kind === "source_not_prepared") {
        failure = {
          category: "internal_invariant_violation",
          message: "The deployment build source is not prepared",
          retryable: false,
        };
      } else if (loaded.kind !== "loaded") {
        this.logger.warn(
          {
            event: "deployment_build_job_load_fenced",
            outcome: loaded.kind,
            workItemId: lease.workItemId,
          },
          "Deployment build input was rejected by its lease",
        );
        return "interrupted";
      } else {
        checkoutId = loaded.build.checkoutId;
        const logSink = {
          write: async (chunks: readonly BuildLogChunk[]): Promise<void> => {
            if (chunks.length === 0) {
              return;
            }
            const append = trackOperation(
              this.store.appendBuildLogs({
                chunks,
                leaseToken: lease.leaseToken,
                maxRetainedBytes: this.logMaxRetainedBytes,
                workItemId: lease.workItemId,
              }),
            );
            const result = await runWithSignal(append, effectiveSignal);
            if (result.kind !== "appended") {
              leaseLostController.abort(new Error("Deployment build log lease was lost"));
              throw new Error("Deployment build log append was fenced");
            }
          },
        };

        let built;
        try {
          built = await runWithSignal(
            trackOperation(
              this.imageBuilder.build(
                {
                  attempt: lease.attemptCount,
                  context: {
                    contextDirectory: join(this.sourceRoot, loaded.build.checkoutId, "source"),
                    contextSha256: loaded.build.contextSha256,
                    dockerfilePath: loaded.build.dockerfilePath,
                    dockerfileResolvedPath: loaded.build.dockerfileResolvedPath,
                    dockerfileSha256: loaded.build.dockerfileSha256,
                  },
                  identity: {
                    deploymentId: loaded.build.deploymentId,
                    organizationId: loaded.build.organizationId,
                    projectId: loaded.build.projectId,
                    sourceRevision: loaded.build.resolvedRevision,
                    treeRevision: loaded.build.treeRevision,
                    workItemId: loaded.build.workItemId,
                  },
                  signal: effectiveSignal,
                },
                logSink,
              ),
            ),
            effectiveSignal,
          );
        } catch (error) {
          if (effectiveSignal.aborted) {
            throw error;
          }
          failure = safeBuildFailure(error);
        }

        if (built !== undefined) {
          const completion = await runWithSignal(
            trackOperation(
              this.store.completeBuild({
                image: {
                  cacheHitCount: built.cacheHitCount,
                  cacheMissCount: built.cacheMissCount,
                  contextSha256: loaded.build.contextSha256,
                  imageId: built.imageId,
                  imageReference: built.imageReference,
                  imageSizeBytes: built.sizeBytes,
                  manifestDigest: built.imageDigest,
                  platform: built.platform,
                },
                leaseToken: lease.leaseToken,
                workItemId: lease.workItemId,
              }),
            ),
            effectiveSignal,
          );
          if (completion.kind === "completed") {
            try {
              await runWithSignal(stopHeartbeatOnce(), attemptSignal);
            } catch {
              // Completion is authoritative; shutdown tracks a delayed heartbeat.
            }
            await cleanupCheckout();
            this.logger.info(
              {
                adopted: built.adopted,
                cacheHitCount: built.cacheHitCount,
                cacheMissCount: built.cacheMissCount,
                event: "deployment_image_built",
                imageId: built.imageId,
                workItemId: lease.workItemId,
              },
              "Deployment image was built and recorded",
            );
            return "completed";
          }
          if (completion.kind === "build_mismatch" || completion.kind === "source_mismatch") {
            failure = {
              category: "internal_invariant_violation",
              message: "The built image did not match the deployment source",
              retryable: false,
            };
          } else {
            this.logger.warn(
              {
                event: "deployment_build_job_completion_fenced",
                outcome: completion.kind,
                workItemId: lease.workItemId,
              },
              "Deployment build completion was rejected by its lease",
            );
            return "interrupted";
          }
        }
      }

      if (failure === undefined) {
        throw new Error("Deployment build processing ended without an outcome");
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
          { event: "deployment_build_job_interrupted", workItemId: lease.workItemId },
          "Deployment build job stopped with a recoverable lease",
        );
        return "interrupted";
      }
      if (!failurePersistenceStarted) {
        try {
          return await persistFailure(safeBuildFailure(error));
        } catch {
          // The safe failure write is reported below without exposing either error.
        }
      }
      this.logger.error(
        {
          event: "deployment_build_failure_persistence_failed",
          workItemId: lease.workItemId,
        },
        "Deployment build failure could not reach authoritative storage",
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
