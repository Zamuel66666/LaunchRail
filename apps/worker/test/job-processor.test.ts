import { describe, expect, it, vi } from "vitest";

import { DeploymentJobProcessor } from "../src/job-processor.js";

const claimJob = {
  contractVersion: 1,
  kind: "deployment.claim",
  workItemId: "11111111-1111-4111-8111-111111111111",
} as const;
const sourceJob = {
  contractVersion: 1,
  kind: "deployment.prepare_source",
  workItemId: "22222222-2222-4222-8222-222222222222",
} as const;
const buildJob = {
  contractVersion: 1,
  kind: "deployment.build",
  workItemId: "33333333-3333-4333-8333-333333333333",
} as const;

describe("DeploymentJobProcessor", () => {
  it("routes each strict job contract to its matching processor", async () => {
    const claimProcess = vi.fn(async () => "completed" as const);
    const sourceProcess = vi.fn(async () => "dead_lettered" as const);
    const buildProcess = vi.fn(async () => "completed" as const);
    const processor = new DeploymentJobProcessor({
      buildProcessor: {
        getActiveJobCount: () => 0,
        process: buildProcess,
        waitForIdle: vi.fn(async () => undefined),
      } as never,
      claimProcessor: {
        getActiveJobCount: () => 0,
        process: claimProcess,
        waitForIdle: vi.fn(async () => undefined),
      } as never,
      sourceProcessor: {
        getActiveJobCount: () => 0,
        process: sourceProcess,
        waitForIdle: vi.fn(async () => undefined),
      } as never,
    });
    const signal = new AbortController().signal;

    await expect(processor.process(claimJob, signal)).resolves.toBe("completed");
    await expect(processor.process(sourceJob, signal)).resolves.toBe("dead_lettered");
    await expect(processor.process(buildJob, signal)).resolves.toBe("completed");
    expect(buildProcess).toHaveBeenCalledWith(buildJob, signal);
    expect(claimProcess).toHaveBeenCalledWith(claimJob, signal);
    expect(sourceProcess).toHaveBeenCalledWith(sourceJob, signal);
  });

  it("aggregates activity and waits for all processor classes to become idle", async () => {
    let buildActive = 3;
    const buildWait = vi.fn(async () => {
      buildActive = 0;
    });
    let claimActive = 1;
    let sourceActive = 2;
    const claimWait = vi.fn(async () => {
      claimActive = 0;
    });
    const sourceWait = vi.fn(async () => {
      sourceActive = 0;
    });
    const processor = new DeploymentJobProcessor({
      buildProcessor: {
        getActiveJobCount: () => buildActive,
        process: vi.fn(),
        waitForIdle: buildWait,
      } as never,
      claimProcessor: {
        getActiveJobCount: () => claimActive,
        process: vi.fn(),
        waitForIdle: claimWait,
      } as never,
      sourceProcessor: {
        getActiveJobCount: () => sourceActive,
        process: vi.fn(),
        waitForIdle: sourceWait,
      } as never,
    });

    expect(processor.getActiveJobCount()).toBe(6);
    await processor.waitForIdle();
    expect(processor.getActiveJobCount()).toBe(0);
    expect(claimWait).toHaveBeenCalledOnce();
    expect(sourceWait).toHaveBeenCalledOnce();
    expect(buildWait).toHaveBeenCalledOnce();
  });
});
