import type {
  DeploymentRuntimeInstanceSummary,
  DeploymentJobStore,
  DeploymentRuntimeManager,
  DeploymentTransitionStore,
  ImageBuilder,
  RepositoryCheckout,
} from "@launchrail/application";
import { parseDeploymentJob, type DeploymentJob } from "@launchrail/contracts";
import type { MetricsRegistry } from "@launchrail/observability";
import { withTraceSpan } from "@launchrail/observability";

import type { WorkerEventLogger } from "./processor.js";
import type { RouteManager } from "@launchrail/routing";

export interface DeploymentJobPublisher {
  enqueue(job: DeploymentJob): Promise<Readonly<{ jobId: string }>>;
}

export interface DeploymentJobReconcilerOptions {
  readonly rollbackProcessor?: { runOnce(): Promise<void> };
  readonly batchSize: number;
  readonly logger: WorkerEventLogger;
  readonly maxAttempts: number;
  readonly metrics?: MetricsRegistry;
  readonly publisher: DeploymentJobPublisher;
  readonly store: DeploymentJobStore;
  readonly transitionStore?: DeploymentTransitionStore;
  readonly routeManager?: RouteManager;
  readonly runtimeManager?: Pick<DeploymentRuntimeManager, "cleanupOrphan" | "listManagedRuntimes">;
  readonly imageBuilder?: Pick<ImageBuilder, "cleanupAbandonedStages" | "cleanupOrphanedImages">;
  readonly repositoryCheckout?: Pick<RepositoryCheckout, "cleanupAbandonedStages" | "remove">;
}

export interface DeploymentJobReconciliationResult {
  readonly deadLettered: number;
  readonly dispatchFailed: number;
  readonly dispatched: number;
  readonly ensured: number;
  readonly recovered: number;
  readonly orphanRuntimesCleaned: number;
  readonly lostRuntimesFailed: number;
  readonly orphanRuntimeCleanupFailures: number;
  readonly sourceStagesRemoved: number;
  readonly buildStagesRemoved: number;
  readonly filesystemCleanupFailures: number;
  readonly finalCheckoutsRemoved: number;
  readonly orphanImagesRemoved: number;
  readonly orphanImageCleanupFailures: number;
  readonly interruptedRouteFilesRemoved: number;
  readonly routeFileCleanupFailures: number;
  readonly routeReconciliationFailures: number;
  readonly resourceRecoveryFailures: number;
}

export class DeploymentJobReconciler {
  private readonly rollbackProcessor: DeploymentJobReconcilerOptions["rollbackProcessor"];
  private readonly batchSize: number;
  private inFlight: Promise<DeploymentJobReconciliationResult> | undefined;
  private readonly logger: WorkerEventLogger;
  private readonly maxAttempts: number;
  private readonly metrics: MetricsRegistry | undefined;
  private readonly publisher: DeploymentJobPublisher;
  private readonly store: DeploymentJobStore;
  private readonly transitionStore: DeploymentTransitionStore | undefined;
  private readonly routeManager: RouteManager | undefined;
  private readonly runtimeManager: DeploymentJobReconcilerOptions["runtimeManager"];
  private readonly imageBuilder: DeploymentJobReconcilerOptions["imageBuilder"];
  private readonly repositoryCheckout: DeploymentJobReconcilerOptions["repositoryCheckout"];

  public constructor({
    batchSize,
    logger,
    maxAttempts,
    metrics,
    publisher,
    store,
    transitionStore,
    routeManager,
    runtimeManager,
    imageBuilder,
    repositoryCheckout,
    rollbackProcessor,
  }: DeploymentJobReconcilerOptions) {
    this.batchSize = batchSize;
    this.logger = logger;
    this.maxAttempts = maxAttempts;
    this.metrics = metrics;
    this.publisher = publisher;
    this.store = store;
    this.transitionStore = transitionStore;
    this.routeManager = routeManager;
    this.runtimeManager = runtimeManager;
    this.imageBuilder = imageBuilder;
    this.repositoryCheckout = repositoryCheckout;
    this.rollbackProcessor = rollbackProcessor;
  }

  public runOnce(): Promise<DeploymentJobReconciliationResult> {
    this.inFlight ??= withTraceSpan("launchrail.worker.reconcile", {}, () =>
      this.reconcile(),
    ).finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  public async waitForIdle(): Promise<void> {
    await this.inFlight;
  }

  private async reconcile(): Promise<DeploymentJobReconciliationResult> {
    const recovered = await this.store.recoverExpired({ limit: this.batchSize });
    let cancellationRecoveryFailures = 0;
    if (this.store.listPendingCancellations !== undefined && this.transitionStore !== undefined) {
      try {
        const cancellations = await this.store.listPendingCancellations({ limit: this.batchSize });
        for (const cancellation of cancellations) {
          try {
            await this.transitionStore.transition({
              ...cancellation,
              to: "cancelled",
              idempotencyKey: `worker-cancelled-${cancellation.deploymentId}`,
            });
          } catch {
            cancellationRecoveryFailures += 1;
            this.logger.warn(
              { event: "deployment_cancellation_completion_failed" },
              "Deployment cancellation completion will be retried",
            );
          }
        }
      } catch {
        cancellationRecoveryFailures += 1;
        this.logger.warn(
          { event: "pending_cancellation_inventory_failed" },
          "Pending deployment cancellations will be retried",
        );
      }
    }
    const ensured = await this.store.ensureMissing({
      limit: this.batchSize,
      maxAttempts: this.maxAttempts,
    });
    const dispatchable = await this.store.listDispatchable({ limit: this.batchSize });
    const olderThan = new Date(Date.now() - 24 * 60 * 60 * 1_000);
    let routeReconciliationFailures = 0;
    let interruptedRouteFilesRemoved = 0;
    let routeFileCleanupFailures = 0;
    if (this.routeManager?.cleanupTemporaryFiles !== undefined) {
      try {
        interruptedRouteFilesRemoved = await this.routeManager.cleanupTemporaryFiles({ olderThan });
      } catch {
        routeFileCleanupFailures += 1;
        this.logger.warn(
          { event: "interrupted_route_file_cleanup_failed" },
          "Interrupted preview route files will be retried during reconciliation",
        );
      }
    }
    let orphanRuntimesCleaned = 0;
    let lostRuntimesFailed = 0;
    let orphanRuntimeCleanupFailures = 0;
    let sourceStagesRemoved = 0;
    let buildStagesRemoved = 0;
    let finalCheckoutsRemoved = 0;
    let filesystemCleanupFailures = 0;
    let orphanImagesRemoved = 0;
    let orphanImageCleanupFailures = 0;
    let resourceRecoveryFailures = cancellationRecoveryFailures;
    if (this.store.listWorkerResourceRecoveryState !== undefined) {
      try {
        const recoveryState = await this.store.listWorkerResourceRecoveryState();
        if (this.repositoryCheckout !== undefined) {
          for (const checkoutKey of recoveryState.cleanupCheckoutKeys) {
            try {
              await this.repositoryCheckout.remove(checkoutKey);
              await this.store.recordSourceCheckoutCleanup?.({ checkoutKey });
              finalCheckoutsRemoved += 1;
            } catch {
              filesystemCleanupFailures += 1;
              this.logger.warn(
                { event: "completed_source_checkout_cleanup_failed" },
                "Completed source checkout cleanup will be retried during reconciliation",
              );
            }
          }
        }
        if (this.repositoryCheckout?.cleanupAbandonedStages !== undefined) {
          try {
            sourceStagesRemoved = await this.repositoryCheckout.cleanupAbandonedStages({
              olderThan,
              protectedCheckoutKeys: recoveryState.leasedCheckoutKeys,
            });
          } catch {
            filesystemCleanupFailures += 1;
            this.logger.warn(
              { event: "orphan_source_stage_cleanup_failed" },
              "Abandoned source staging cleanup will be retried during reconciliation",
            );
          }
        }
        if (this.imageBuilder?.cleanupAbandonedStages !== undefined) {
          try {
            buildStagesRemoved = await this.imageBuilder.cleanupAbandonedStages({
              olderThan,
              protectedWorkItemIds: recoveryState.leasedBuildWorkItemIds,
            });
          } catch {
            filesystemCleanupFailures += 1;
            this.logger.warn(
              { event: "orphan_build_stage_cleanup_failed" },
              "Abandoned build staging cleanup will be retried during reconciliation",
            );
          }
        }
        if (this.imageBuilder?.cleanupOrphanedImages !== undefined) {
          try {
            const cleanup = await this.imageBuilder.cleanupOrphanedImages({
              knownImageIds: recoveryState.knownImageIds,
              olderThan,
              protectedWorkItemIds: recoveryState.leasedBuildWorkItemIds,
              signal: AbortSignal.timeout(30_000),
            });
            orphanImagesRemoved = cleanup.removed;
            orphanImageCleanupFailures = cleanup.failed;
            if (cleanup.failed > 0)
              this.logger.warn(
                { event: "orphan_build_image_cleanup_failed", failed: cleanup.failed },
                "Orphan build image cleanup will be retried during reconciliation",
              );
          } catch {
            orphanImageCleanupFailures += 1;
            this.logger.warn(
              { event: "orphan_build_image_inventory_failed" },
              "Orphan build image inventory will be retried during reconciliation",
            );
          }
        }
        if (this.runtimeManager?.listManagedRuntimes !== undefined) {
          let expectedRuntimes: readonly DeploymentRuntimeInstanceSummary[] | undefined;
          if (this.store.listRoutableRuntimes !== undefined) {
            try {
              expectedRuntimes = await this.store.listRoutableRuntimes();
            } catch {
              resourceRecoveryFailures += 1;
              this.logger.warn(
                { event: "expected_runtime_inventory_failed" },
                "Missing runtime detection will be retried during reconciliation",
              );
            }
          }
          try {
            const signal = new AbortController().signal;
            const managed = await this.runtimeManager.listManagedRuntimes(signal);
            if (expectedRuntimes !== undefined && this.transitionStore !== undefined) {
              const liveContainerIds = new Set(managed.map((runtime) => runtime.containerId));
              const leasedDeployments = new Set(recoveryState.leasedRuntimeDeploymentIds);
              for (const expected of expectedRuntimes) {
                if (
                  liveContainerIds.has(expected.containerId) ||
                  leasedDeployments.has(expected.deploymentId)
                )
                  continue;
                try {
                  await this.transitionStore.transition({
                    deploymentId: expected.deploymentId,
                    failure: {
                      category: "runtime_start_failed",
                      message: "The active runtime is no longer present on the Docker host",
                    },
                    idempotencyKey: `worker-runtime-lost-${expected.deploymentId}`,
                    organizationId: expected.organizationId,
                    to: "deployment_failed",
                  });
                  lostRuntimesFailed += 1;
                  this.logger.error(
                    { deploymentId: expected.deploymentId, event: "active_runtime_missing" },
                    "A deployment runtime disappeared from Docker and was marked failed",
                  );
                } catch {
                  resourceRecoveryFailures += 1;
                  this.logger.warn(
                    {
                      deploymentId: expected.deploymentId,
                      event: "missing_runtime_recovery_failed",
                    },
                    "Missing runtime recovery will be retried during reconciliation",
                  );
                }
              }
            }
            const knownIds = new Set(recoveryState.knownContainerIds);
            const cleanupIds = new Set(recoveryState.cleanupContainerIds);
            const leasedWorkItems = new Set(recoveryState.leasedWorkItemIds);
            let orphanInventory = 0;
            if (this.runtimeManager.cleanupOrphan !== undefined) {
              for (const runtime of managed) {
                if (
                  (knownIds.has(runtime.containerId) && !cleanupIds.has(runtime.containerId)) ||
                  leasedWorkItems.has(runtime.identity.workItemId)
                )
                  continue;
                orphanInventory += 1;
                let removed = false;
                const cleanupStartedAt = performance.now();
                let cleanupOutcome: "removed" | "failed" = "removed";
                try {
                  await this.runtimeManager.cleanupOrphan({ ...runtime, signal });
                  removed = true;
                  await this.store.recordRuntimeCleanup?.({
                    containerId: runtime.containerId,
                    state: "complete",
                  });
                  orphanRuntimesCleaned += 1;
                } catch {
                  cleanupOutcome = "failed";
                  if (!removed) {
                    try {
                      await this.store.recordRuntimeCleanup?.({
                        containerId: runtime.containerId,
                        state: "failed",
                      });
                    } catch {
                      // Runtime label inventory still protects the resource for a later pass.
                    }
                  }
                  orphanRuntimeCleanupFailures += 1;
                  this.logger.warn(
                    {
                      event: removed
                        ? "orphan_runtime_cleanup_state_record_failed"
                        : "orphan_runtime_cleanup_failed",
                      workItemId: runtime.identity.workItemId,
                    },
                    "Orphan runtime cleanup will be reconciled again",
                  );
                } finally {
                  this.metrics?.observe(
                    "launchrail_worker_runtime_cleanup_duration_seconds",
                    Math.max(0, performance.now() - cleanupStartedAt) / 1_000,
                    { outcome: cleanupOutcome },
                  );
                }
              }
            }
            this.metrics?.setGauge("launchrail_worker_orphan_runtime_inventory", orphanInventory);
          } catch {
            orphanRuntimeCleanupFailures += 1;
            this.logger.warn(
              { event: "orphan_runtime_inventory_failed" },
              "Managed runtime inventory will be retried during reconciliation",
            );
          }
        }
      } catch {
        resourceRecoveryFailures += 1;
        this.logger.warn(
          { event: "worker_resource_recovery_failed" },
          "Resource cleanup will be retried during reconciliation",
        );
      }
    }
    if (
      this.routeManager?.reconcile !== undefined &&
      this.store.listRoutableRuntimes !== undefined
    ) {
      const routeTime = performance.now();
      let routeOutcome: "reconciled" | "failed" = "reconciled";
      try {
        const runtimes = await this.store.listRoutableRuntimes();
        const mismatches = await this.routeManager.reconcile(
          runtimes.map((runtime) => ({
            deploymentId: runtime.deploymentId,
            hostname: `d-${runtime.deploymentId}.localhost`,
            target: { hostPort: runtime.hostPort },
          })),
        );
        if (mismatches !== undefined)
          this.metrics?.setGauge("launchrail_worker_route_configuration_mismatches", mismatches);
      } catch {
        routeOutcome = "failed";
        routeReconciliationFailures += 1;
        this.logger.warn(
          { event: "preview_route_reconciliation_failed" },
          "Preview route restoration will be retried during reconciliation",
        );
      } finally {
        this.metrics?.observe(
          "launchrail_worker_route_reconciliation_duration_seconds",
          Math.max(0, performance.now() - routeTime) / 1_000,
          { outcome: routeOutcome },
        );
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
    try {
      await this.rollbackProcessor?.runOnce();
    } catch {
      resourceRecoveryFailures += 1;
      this.logger.warn(
        { event: "rollback_reconciliation_failed" },
        "Durable rollback work will be retried",
      );
    }
    const result = {
      deadLettered,
      dispatchFailed,
      dispatched,
      ensured: ensured.length,
      orphanRuntimesCleaned,
      lostRuntimesFailed,
      orphanRuntimeCleanupFailures,
      sourceStagesRemoved,
      buildStagesRemoved,
      filesystemCleanupFailures,
      finalCheckoutsRemoved,
      orphanImagesRemoved,
      orphanImageCleanupFailures,
      interruptedRouteFilesRemoved,
      routeFileCleanupFailures,
      routeReconciliationFailures,
      resourceRecoveryFailures,
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
    for (let index = 0; index < lostRuntimesFailed; index += 1)
      this.metrics?.increment("launchrail_worker_lost_runtimes_failed_total");
    for (let index = 0; index < orphanRuntimeCleanupFailures; index += 1)
      this.metrics?.increment("launchrail_worker_orphan_runtime_cleanup_failures_total");
    for (let index = 0; index < sourceStagesRemoved; index += 1)
      this.metrics?.increment("launchrail_worker_source_stages_removed_total");
    for (let index = 0; index < buildStagesRemoved; index += 1)
      this.metrics?.increment("launchrail_worker_build_stages_removed_total");
    for (let index = 0; index < filesystemCleanupFailures; index += 1)
      this.metrics?.increment("launchrail_worker_filesystem_cleanup_failures_total");
    for (let index = 0; index < finalCheckoutsRemoved; index += 1)
      this.metrics?.increment("launchrail_worker_final_checkouts_removed_total");
    for (let index = 0; index < orphanImagesRemoved; index += 1)
      this.metrics?.increment("launchrail_worker_orphan_build_images_removed_total");
    for (let index = 0; index < orphanImageCleanupFailures; index += 1)
      this.metrics?.increment("launchrail_worker_orphan_build_image_cleanup_failures_total");
    for (let index = 0; index < interruptedRouteFilesRemoved; index += 1)
      this.metrics?.increment("launchrail_worker_interrupted_route_files_removed_total");
    for (let index = 0; index < routeFileCleanupFailures; index += 1)
      this.metrics?.increment("launchrail_worker_route_file_cleanup_failures_total");
    for (let index = 0; index < routeReconciliationFailures; index += 1)
      this.metrics?.increment("launchrail_worker_route_reconciliation_failures_total");
    for (let index = 0; index < resourceRecoveryFailures; index += 1)
      this.metrics?.increment("launchrail_worker_resource_recovery_failures_total");
    this.logger.info(
      { event: "deployment_job_reconciliation", ...result },
      "Deployment job reconciliation pass completed",
    );
    return result;
  }
}
