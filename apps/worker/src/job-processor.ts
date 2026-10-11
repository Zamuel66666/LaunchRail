import type { DeploymentJob } from "@launchrail/contracts";

import type { DeploymentBuildProcessor } from "./build-processor.js";
import type { DeploymentClaimProcessor, DeploymentJobProcessingOutcome } from "./processor.js";
import type { DeploymentSourceProcessor } from "./source-processor.js";
import type { DeploymentRuntimeProcessor } from "./runtime-processor.js";
import { withTraceSpan } from "@launchrail/observability";

export interface DeploymentJobProcessorOptions {
  readonly buildProcessor: DeploymentBuildProcessor;
  readonly claimProcessor: DeploymentClaimProcessor;
  readonly sourceProcessor: DeploymentSourceProcessor;
  readonly runtimeProcessor: DeploymentRuntimeProcessor;
}

export class DeploymentJobProcessor {
  private readonly buildProcessor: DeploymentBuildProcessor;
  private readonly claimProcessor: DeploymentClaimProcessor;
  private readonly sourceProcessor: DeploymentSourceProcessor;
  private readonly runtimeProcessor: DeploymentRuntimeProcessor;

  public constructor({
    buildProcessor,
    claimProcessor,
    sourceProcessor,
    runtimeProcessor,
  }: DeploymentJobProcessorOptions) {
    this.buildProcessor = buildProcessor;
    this.claimProcessor = claimProcessor;
    this.sourceProcessor = sourceProcessor;
    this.runtimeProcessor = runtimeProcessor;
  }

  public process(job: DeploymentJob, signal: AbortSignal): Promise<DeploymentJobProcessingOutcome> {
    return withTraceSpan(
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
        }
      },
    );
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
