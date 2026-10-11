import type { DeploymentJob } from "@launchrail/contracts";
import { withTraceSpan, type MetricsRegistry } from "@launchrail/observability";

import type { DeploymentBuildProcessor } from "./build-processor.js";
import type { DeploymentClaimProcessor, DeploymentJobProcessingOutcome } from "./processor.js";
import type { DeploymentSourceProcessor } from "./source-processor.js";
import type { DeploymentRuntimeProcessor } from "./runtime-processor.js";

export interface DeploymentJobProcessorOptions {
  readonly buildProcessor: DeploymentBuildProcessor;
  readonly claimProcessor: DeploymentClaimProcessor;
  readonly sourceProcessor: DeploymentSourceProcessor;
  readonly runtimeProcessor: DeploymentRuntimeProcessor;
  readonly metrics?: MetricsRegistry;
}

export class DeploymentJobProcessor {
  private readonly buildProcessor: DeploymentBuildProcessor;
  private readonly claimProcessor: DeploymentClaimProcessor;
  private readonly sourceProcessor: DeploymentSourceProcessor;
  private readonly runtimeProcessor: DeploymentRuntimeProcessor;
  private readonly metrics: MetricsRegistry | undefined;

  public constructor({
    buildProcessor,
    claimProcessor,
    sourceProcessor,
    runtimeProcessor,
    metrics,
  }: DeploymentJobProcessorOptions) {
    this.buildProcessor = buildProcessor;
    this.claimProcessor = claimProcessor;
    this.sourceProcessor = sourceProcessor;
    this.runtimeProcessor = runtimeProcessor;
    this.metrics = metrics;
  }

  public async process(
    job: DeploymentJob,
    signal: AbortSignal,
  ): Promise<DeploymentJobProcessingOutcome> {
    const startedAt = performance.now();
    let outcome: DeploymentJobProcessingOutcome | "exception" = "exception";
    try {
      outcome = await withTraceSpan(
        "launchrail.deployment.process",
        { "launchrail.job.kind": job.kind, "launchrail.work_item.id": job.workItemId },
        async () => {
          switch (job.kind) {
            case "deployment.build":
              return await this.buildProcessor.process(job, signal);
            case "deployment.claim":
              return await this.claimProcessor.process(job, signal);
            case "deployment.prepare_source":
              return await this.sourceProcessor.process(job, signal);
            case "deployment.start_runtime":
              return await this.runtimeProcessor.process(job, signal);
            default:
              throw new Error("Unsupported deployment job kind");
          }
        },
      );
      return outcome;
    } finally {
      if (outcome === "retry_scheduled")
        this.metrics?.increment("launchrail_worker_deployment_job_retries_total", {
          kind: job.kind,
        });
      if (signal.aborted && signal.reason instanceof Error && signal.reason.name === "TimeoutError")
        this.metrics?.increment("launchrail_worker_deployment_job_timeouts_total", {
          kind: job.kind,
        });
      this.metrics?.increment("launchrail_worker_deployment_jobs_processed_total", {
        kind: job.kind,
        outcome,
      });
      this.metrics?.observe(
        "launchrail_worker_deployment_job_processing_duration_seconds",
        Math.max(0, performance.now() - startedAt) / 1_000,
        { kind: job.kind, outcome },
      );
    }
  }

  public getActiveJobCount(): number {
    return (
      this.buildProcessor.getActiveJobCount() +
      this.claimProcessor.getActiveJobCount() +
      this.sourceProcessor.getActiveJobCount() +
      this.runtimeProcessor.getActiveJobCount()
    );
  }

  public async waitForIdle(): Promise<void> {
    while (this.getActiveJobCount() > 0) {
      await Promise.all([
        this.buildProcessor.waitForIdle(),
        this.claimProcessor.waitForIdle(),
        this.sourceProcessor.waitForIdle(),
        this.runtimeProcessor.waitForIdle(),
      ]);
    }
  }
}
