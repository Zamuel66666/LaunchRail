import type { DeploymentJobStore, DeploymentRuntimeManager } from "@launchrail/application";
import { parseDeploymentJob, type DeploymentJob } from "@launchrail/contracts";
import type { MetricsRegistry } from "@launchrail/observability";

import type { WorkerEventLogger } from "./processor.js";
import type { RouteManager } from "@launchrail/routing";

export interface DeploymentJobPublisher {
  enqueue(job: DeploymentJob): Promise<Readonly<{ jobId: string }>>;
}

export interface DeploymentJobReconcilerOptions {
  readonly batchSize: number;
  readonly logger: WorkerEventLogger;
  readonly maxAttempts: number;
  readonly metrics?: MetricsRegistry;
  readonly publisher: DeploymentJobPublisher;
  readonly store: DeploymentJobStore;
  readonly routeManager?: RouteManager;
  readonly runtimeManager?: Pick<DeploymentRuntimeManager, "cleanupOrphan" | "listManagedRuntimes">;
}

export interface DeploymentJobReconciliationResult {
  readonly deadLettered: number;
  readonly dispatchFailed: number;
  readonly dispatched: number;
  readonly ensured: number;
  readonly recovered: number;
  readonly orphanRuntimesCleaned: number;
  readonly orphanRuntimeCleanupFailures: number;
}

export class DeploymentJobReconciler {
  private readonly batchSize: number;
  private inFlight: Promise<DeploymentJobReconciliationResult> | undefined;
  private readonly logger: WorkerEventLogger;
  private readonly maxAttempts: number;
  private readonly metrics: MetricsRegistry | undefined;
  private readonly publisher: DeploymentJobPublisher;
  private readonly store: DeploymentJobStore;
  private readonly routeManager: RouteManager | undefined;
  private readonly runtimeManager: DeploymentJobReconcilerOptions["runtimeManager"];

  public constructor({
    batchSize,
    logger,
    maxAttempts,
    metrics,
    publisher,
    store,
    routeManager,
    runtimeManager,
  }: DeploymentJobReconcilerOptions) {
    this.batchSize = batchSize;
    this.logger = logger;
    this.maxAttempts = maxAttempts;
    this.metrics = metrics;
    this.publisher = publisher;
    this.store = store;
    this.routeManager = routeManager;
    this.runtimeManager = runtimeManager;
  }

  public runOnce(): Promise<DeploymentJobReconciliationResult> {
    this.inFlight ??= this.reconcile().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  public async waitForIdle(): Promise<void> {
    await this.inFlight;
  }

  private async reconcile(): Promise<DeploymentJobReconciliationResult> {
    const recovered = await this.store.recoverExpired({ limit: this.batchSize });
    const ensured = await this.store.ensureMissing({
      limit: this.batchSize,
      maxAttempts: this.maxAttempts,
    });
    const dispatchable = await this.store.listDispatchable({ limit: this.batchSize });
    if (
      this.routeManager?.reconcile !== undefined &&
      this.store.listRoutableRuntimes !== undefined
    ) {
      const runtimes = await this.store.listRoutableRuntimes();
      await this.routeManager.reconcile(
        runtimes.map((runtime) => ({
          deploymentId: runtime.deploymentId,
          hostname: `d-${runtime.deploymentId}.localhost`,
          target: { hostPort: runtime.hostPort },
        })),
      );
    }
    let orphanRuntimesCleaned = 0;
    let orphanRuntimeCleanupFailures = 0;
    if (
      this.runtimeManager?.listManagedRuntimes !== undefined &&
      this.runtimeManager.cleanupOrphan !== undefined &&
      this.store.listRuntimeRecoveryState !== undefined
    ) {
      const recoveryState = await this.store.listRuntimeRecoveryState();
      const knownIds = new Set(recoveryState.knownContainerIds);
      const cleanupIds = new Set(recoveryState.cleanupContainerIds);
      const leasedWorkItems = new Set(recoveryState.leasedWorkItemIds);
      const signal = new AbortController().signal;
      const managed = await this.runtimeManager.listManagedRuntimes(signal);
      for (const runtime of managed) {
        if (
          (knownIds.has(runtime.containerId) && !cleanupIds.has(runtime.containerId)) ||
          leasedWorkItems.has(runtime.identity.workItemId)
        )
          continue;
        try {
          await this.runtimeManager.cleanupOrphan({ ...runtime, signal });
          await this.store.recordRuntimeCleanup?.({
            containerId: runtime.containerId,
            organizationId: runtime.identity.organizationId,
            state: "complete",
          });
          orphanRuntimesCleaned += 1;
        } catch (error) {
          await this.store.recordRuntimeCleanup?.({
            containerId: runtime.containerId,
            organizationId: runtime.identity.organizationId,
            state: "failed",
          });
          orphanRuntimeCleanupFailures += 1;
          this.logger.warn(
            {
              containerId: runtime.containerId,
              error,
              event: "orphan_runtime_cleanup_failed",
              workItemId: runtime.identity.workItemId,
            },
            "Orphan runtime cleanup will be retried during reconciliation",
          );
        }
      }
    }
    let dispatched = 0;
    let dispatchFailed = 0;

    for (const job of dispatchable) {
      try {
        await this.publisher.enqueue(
          parseDeploymentJob({
            contractVersion: job.contractVersion,
            kind: job.kind,
            workItemId: job.id,
          }),
        );
        dispatched += 1;
      } catch {
        dispatchFailed += 1;
        this.logger.warn(
          { event: "deployment_job_dispatch_failed", workItemId: job.id },
          "Deployment job remains durable for a later reconciliation pass",
        );
      }
    }

    const deadLettered = recovered.filter((job) => job.status === "dead_lettered").length;
    const result = {
      deadLettered,
      dispatchFailed,
      dispatched,
      ensured: ensured.length,
      orphanRuntimesCleaned,
      orphanRuntimeCleanupFailures,
      recovered: recovered.length,
    };
    this.metrics?.increment("launchrail_worker_reconciliations_total");
    for (let index = 0; index < deadLettered; index += 1) {
      this.metrics?.increment("launchrail_worker_jobs_dead_lettered_total");
    }
    for (let index = 0; index < dispatchFailed; index += 1) {
      this.metrics?.increment("launchrail_worker_job_dispatch_failures_total");
    }
    for (let index = 0; index < dispatched; index += 1) {
      this.metrics?.increment("launchrail_worker_jobs_dispatched_total");
    }
    for (let index = 0; index < ensured.length; index += 1) {
      this.metrics?.increment("launchrail_worker_jobs_ensured_total");
    }
    for (let index = 0; index < recovered.length; index += 1) {
      this.metrics?.increment("launchrail_worker_jobs_recovered_total");
    }
    for (let index = 0; index < orphanRuntimesCleaned; index += 1)
      this.metrics?.increment("launchrail_worker_orphan_runtimes_cleaned_total");
    for (let index = 0; index < orphanRuntimeCleanupFailures; index += 1)
      this.metrics?.increment("launchrail_worker_orphan_runtime_cleanup_failures_total");
    this.logger.info(
      { event: "deployment_job_reconciliation", ...result },
      "Deployment job reconciliation pass completed",
    );
    return result;
  }
}
