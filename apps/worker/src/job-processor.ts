import type { DeploymentJob } from "@launchrail/contracts";

import type { DeploymentClaimProcessor, DeploymentJobProcessingOutcome } from "./processor.js";
import type { DeploymentSourceProcessor } from "./source-processor.js";

export interface DeploymentJobProcessorOptions {
  readonly claimProcessor: DeploymentClaimProcessor;
  readonly sourceProcessor: DeploymentSourceProcessor;
}

export class DeploymentJobProcessor {
  private readonly claimProcessor: DeploymentClaimProcessor;
  private readonly sourceProcessor: DeploymentSourceProcessor;

  public constructor({ claimProcessor, sourceProcessor }: DeploymentJobProcessorOptions) {
    this.claimProcessor = claimProcessor;
    this.sourceProcessor = sourceProcessor;
  }

  public process(job: DeploymentJob, signal: AbortSignal): Promise<DeploymentJobProcessingOutcome> {
    return job.kind === "deployment.claim"
      ? this.claimProcessor.process(job, signal)
      : this.sourceProcessor.process(job, signal);
  }

  public getActiveJobCount(): number {
    return this.claimProcessor.getActiveJobCount() + this.sourceProcessor.getActiveJobCount();
  }

  public async waitForIdle(): Promise<void> {
    while (this.getActiveJobCount() > 0) {
      await Promise.all([this.claimProcessor.waitForIdle(), this.sourceProcessor.waitForIdle()]);
    }
  }
}
