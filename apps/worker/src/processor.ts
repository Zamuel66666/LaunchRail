import type { DeploymentJobLease, DeploymentJobStore } from "@launchrail/application";
import type { DeploymentClaimJob } from "@launchrail/contracts";
import { computeDeploymentClaimBackoffMs } from "@launchrail/queue";

export interface WorkerEventLogger {
  error(bindings: Readonly<Record<string, unknown>>, message: string): void;
  info(bindings: Readonly<Record<string, unknown>>, message: string): void;
  warn(bindings: Readonly<Record<string, unknown>>, message: string): void;
}

export type DeploymentClaimProcessingOutcome =
  | "completed"
  | "dead_lettered"
  | "infrastructure_unavailable"
  | "interrupted"
  | "lease_unavailable"
  | "retry_scheduled"
  | "terminal";

export interface DeploymentClaimProcessorOptions {
  readonly backoffBaseMs: number;
  readonly backoffCapMs: number;
  readonly heartbeatIntervalMs: number;
  readonly jobTimeoutMs: number;
  readonly leaseDurationMs: number;
  readonly logger: WorkerEventLogger;
  readonly onActiveJobCountChanged?: (activeJobCount: number) => void;
  readonly store: DeploymentJobStore;
  readonly workerId: string;
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

export class DeploymentClaimProcessor {
  private activeJobCount = 0;
  private readonly backoffBaseMs: number;
  private readonly backoffCapMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly jobTimeoutMs: number;
  private readonly leaseDurationMs: number;
  private readonly logger: WorkerEventLogger;
  private readonly idleWaiters = new Set<() => void>();
  private readonly onActiveJobCountChanged: (activeJobCount: number) => void;
  private readonly store: DeploymentJobStore;
  private readonly workerId: string;

  public constructor({
    backoffBaseMs,
    backoffCapMs,
    heartbeatIntervalMs,
    jobTimeoutMs,
    leaseDurationMs,
    logger,
    onActiveJobCountChanged = () => undefined,
    store,
    workerId,
  }: DeploymentClaimProcessorOptions) {
    this.backoffBaseMs = backoffBaseMs;
    this.backoffCapMs = backoffCapMs;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.jobTimeoutMs = jobTimeoutMs;
    this.leaseDurationMs = leaseDurationMs;
    this.logger = logger;
    this.onActiveJobCountChanged = onActiveJobCountChanged;
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
    this.onActiveJobCountChanged(value);
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
      inFlight = (async () => {
        const result = await this.store.heartbeat({
          leaseDurationMs: this.leaseDurationMs,
          leaseToken: lease.leaseToken,
          workItemId: lease.workItemId,
        });
        if (result.kind !== "extended") {
          leaseLostController.abort(new Error("Deployment job lease was lost"));
        }
      })()
        .catch(() => {
          leaseLostController.abort(new Error("Deployment job lease heartbeat failed"));
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
    job: DeploymentClaimJob,
    shutdownSignal: AbortSignal,
  ): Promise<DeploymentClaimProcessingOutcome> {
    if (shutdownSignal.aborted) {
      return "interrupted";
    }

    const timeoutSignal = AbortSignal.timeout(this.jobTimeoutMs);
    const attemptSignal = AbortSignal.any([shutdownSignal, timeoutSignal]);
    let claimSettled = false;
    const claimOperation = this.store.claim({
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
            ? "deployment_job_claim_timed_out"
            : "deployment_job_claim_failed",
          workItemId: job.workItemId,
        },
        "Deployment job claim could not reach authoritative storage",
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
    const unsettledAuthoritativeOperations = new Set<Promise<unknown>>();
    const trackAuthoritativeOperation = <T>(operation: Promise<T>): Promise<T> => {
      unsettledAuthoritativeOperations.add(operation);
      void operation.then(
        () => unsettledAuthoritativeOperations.delete(operation),
        () => unsettledAuthoritativeOperations.delete(operation),
      );
      return operation;
    };
    let heartbeatStopPromise: Promise<void> | undefined;
    const stopHeartbeatOnce = (): Promise<void> => {
      heartbeatStopPromise ??= stopHeartbeat();
      return heartbeatStopPromise;
    };
    this.setActiveJobCount(this.activeJobCount + 1);

    try {
      const atomicCompletion = trackAuthoritativeOperation(
        this.store.completeClaimTransition({
          leaseToken: lease.leaseToken,
          workItemId: lease.workItemId,
        }),
      );
      const completion = await runWithSignal(atomicCompletion, effectiveSignal);
      if (completion.kind !== "completed") {
        this.logger.warn(
          {
            event: "deployment_job_completion_fenced",
            outcome: completion.kind,
            workItemId: lease.workItemId,
          },
          "Deployment job completion was rejected by its lease",
        );
        try {
          await runWithSignal(stopHeartbeatOnce(), attemptSignal);
        } catch {
          // The finalizer keeps this attempt active until the heartbeat settles
          // if shutdown or the attempt deadline interrupts this wait.
        }
        return "interrupted";
      }

      try {
        await runWithSignal(stopHeartbeatOnce(), attemptSignal);
      } catch {
        // The database transaction already completed authoritatively. A delayed
        // heartbeat may be abandoned safely during bounded shutdown.
      }

      this.logger.info(
        {
          attempt: lease.attemptCount,
          event: "deployment_job_completed",
          workItemId: lease.workItemId,
        },
        "Deployment claim job completed",
      );
      return "completed";
    } catch {
      try {
        await runWithSignal(stopHeartbeatOnce(), attemptSignal);
      } catch {
        // The lease remains recoverable if its final heartbeat does not settle.
      }
      if (effectiveSignal.aborted) {
        this.logger.warn(
          { event: "deployment_job_interrupted", workItemId: lease.workItemId },
          "Deployment job stopped with a recoverable lease",
        );
        return "interrupted";
      }

      const delayMs = computeDeploymentClaimBackoffMs({
        attempt: lease.attemptCount,
        baseDelayMs: this.backoffBaseMs,
        maxDelayMs: this.backoffCapMs,
        workItemId: lease.workItemId,
      });

      try {
        const failurePersistence = trackAuthoritativeOperation(
          this.store.fail({
            leaseToken: lease.leaseToken,
            retryDelayMs: delayMs,
            safeErrorCode: "worker_step_failed",
            safeErrorMessage: "Deployment claim could not complete and is safe to retry",
            workItemId: lease.workItemId,
          }),
        );
        const failed = await runWithSignal(failurePersistence, attemptSignal);
        if (failed.kind === "dead_lettered") {
          this.logger.error(
            {
              attempt: failed.attemptCount,
              event: "deployment_job_dead_lettered",
              workItemId: lease.workItemId,
            },
            "Deployment claim exhausted its retry policy",
          );
          return "dead_lettered";
        }
        if (failed.kind === "retry_scheduled") {
          this.logger.warn(
            {
              attempt: failed.attemptCount,
              availableAt: failed.availableAt.toISOString(),
              event: "deployment_job_retry_scheduled",
              workItemId: lease.workItemId,
            },
            "Deployment claim retry was persisted",
          );
          return "retry_scheduled";
        }
      } catch {
        this.logger.error(
          { event: "deployment_job_failure_persistence_failed", workItemId: lease.workItemId },
          "Deployment job failure could not reach authoritative storage",
        );
      }
      return "interrupted";
    } finally {
      const heartbeatSettlement = stopHeartbeatOnce();
      if (unsettledAuthoritativeOperations.size === 0 && !attemptSignal.aborted) {
        this.setActiveJobCount(this.activeJobCount - 1);
      } else {
        void Promise.allSettled([...unsettledAuthoritativeOperations, heartbeatSettlement]).then(
          () => {
            this.setActiveJobCount(this.activeJobCount - 1);
          },
        );
      }
    }
  }
}
