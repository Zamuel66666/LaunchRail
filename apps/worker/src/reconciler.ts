import type { DeploymentJobStore } from "@launchrail/application";
import { parseDeploymentClaimJob, type DeploymentClaimJob } from "@launchrail/contracts";

import type { WorkerEventLogger } from "./processor.js";

export interface DeploymentClaimPublisher {
  enqueue(job: DeploymentClaimJob): Promise<Readonly<{ jobId: string }>>;
}

export interface DeploymentJobReconcilerOptions {
  readonly batchSize: number;
  readonly logger: WorkerEventLogger;
  readonly maxAttempts: number;
  readonly publisher: DeploymentClaimPublisher;
  readonly store: DeploymentJobStore;
}

export interface DeploymentJobReconciliationResult {
  readonly deadLettered: number;
  readonly dispatchFailed: number;
  readonly dispatched: number;
  readonly ensured: number;
  readonly recovered: number;
}

export class DeploymentJobReconciler {
  private readonly batchSize: number;
  private inFlight: Promise<DeploymentJobReconciliationResult> | undefined;
  private readonly logger: WorkerEventLogger;
  private readonly maxAttempts: number;
  private readonly publisher: DeploymentClaimPublisher;
  private readonly store: DeploymentJobStore;

  public constructor({
    batchSize,
    logger,
    maxAttempts,
    publisher,
    store,
  }: DeploymentJobReconcilerOptions) {
    this.batchSize = batchSize;
    this.logger = logger;
    this.maxAttempts = maxAttempts;
    this.publisher = publisher;
    this.store = store;
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
    const ensured = await this.store.ensureMissingClaims({
      limit: this.batchSize,
      maxAttempts: this.maxAttempts,
    });
    const dispatchable = await this.store.listDispatchable({ limit: this.batchSize });
    let dispatched = 0;
    let dispatchFailed = 0;

    for (const job of dispatchable) {
      try {
        await this.publisher.enqueue(
          parseDeploymentClaimJob({
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
      recovered: recovered.length,
    };
    this.logger.info(
      { event: "deployment_job_reconciliation", ...result },
      "Deployment job reconciliation pass completed",
    );
    return result;
  }
}
