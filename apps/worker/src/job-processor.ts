import type { DeploymentJob } from "@launchrail/contracts";

import type { DeploymentBuildProcessor } from "./build-processor.js";
import type { DeploymentClaimProcessor, DeploymentJobProcessingOutcome } from "./processor.js";
import type { DeploymentSourceProcessor } from "./source-processor.js";

export interface DeploymentJobProcessorOptions {
  readonly buildProcessor: DeploymentBuildProcessor;
  readonly claimProcessor: DeploymentClaimProcessor;
  readonly sourceProcessor: DeploymentSourceProcessor;
}

export class DeploymentJobProcessor {
  private readonly buildProcessor: DeploymentBuildProcessor;
  private readonly claimProcessor: DeploymentClaimProcessor;
  private readonly sourceProcessor: DeploymentSourceProcessor;

  public constructor({
    buildProcessor,
    claimProcessor,
    sourceProcessor,
  }: DeploymentJobProcessorOptions) {
    this.buildProcessor = buildProcessor;
    this.claimProcessor = claimProcessor;
    this.sourceProcessor = sourceProcessor;
  }

  public process(job: DeploymentJob, signal: AbortSignal): Promise<DeploymentJobProcessingOutcome> {
    switch (job.kind) {
      case "deployment.build":
        return this.buildProcessor.process(job, signal);
      case "deployment.claim":
        return this.claimProcessor.process(job, signal);
      case "deployment.prepare_source":
        return this.sourceProcessor.process(job, signal);
    }
  }

  public getActiveJobCount(): number {
    return (
      this.buildProcessor.getActiveJobCount() +
      this.claimProcessor.getActiveJobCount() +
      this.sourceProcessor.getActiveJobCount()
    );
  }

  public async waitForIdle(): Promise<void> {
    while (this.getActiveJobCount() > 0) {
      await Promise.all([
        this.buildProcessor.waitForIdle(),
        this.claimProcessor.waitForIdle(),
        this.sourceProcessor.waitForIdle(),
      ]);
    }
  }
}
