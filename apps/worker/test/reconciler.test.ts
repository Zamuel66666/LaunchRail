import type { DeploymentJobStore } from "@launchrail/application";
import { MetricsRegistry } from "@launchrail/observability";
import { describe, expect, it, vi } from "vitest";

import { DeploymentJobReconciler } from "../src/reconciler.js";
import type { WorkerEventLogger } from "../src/processor.js";

const workItemId = "11111111-1111-4111-8111-111111111111";
const sourceWorkItemId = "44444444-4444-4444-8444-444444444444";

const logger: WorkerEventLogger = {
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
};

function createStore(overrides: Partial<DeploymentJobStore> = {}): DeploymentJobStore {
  return {
    appendBuildLogs: vi.fn(async () => ({ kind: "not_found" as const })),
    claim: vi.fn(async () => ({ kind: "not_found" as const })),
    completeBuild: vi.fn(async () => ({ kind: "not_found" as const })),
    completeRuntime: vi.fn(async () => ({ kind: "not_found" as const })),
    completeClaimTransition: vi.fn(async () => ({ kind: "not_found" as const })),
    completeSourcePreparation: vi.fn(async () => ({ kind: "not_found" as const })),
    ensureMissing: vi.fn(async () => []),
    ensureMissingClaims: vi.fn(async () => []),
    ensurePendingClaim: vi.fn(async () => ({ kind: "deployment_not_found" as const })),
    fail: vi.fn(async () => ({ kind: "not_found" as const })),
    failBuild: vi.fn(async () => ({ kind: "not_found" as const })),
    failRuntime: vi.fn(async () => ({ kind: "not_found" as const })),
    failSourcePreparation: vi.fn(async () => ({ kind: "not_found" as const })),
    heartbeat: vi.fn(async () => ({ kind: "not_found" as const })),
    listDispatchable: vi.fn(async () => []),
    listWorkerHeartbeats: vi.fn(async () => []),
    loadBuildInput: vi.fn(async () => ({ kind: "not_found" as const })),
    loadRuntimeInput: vi.fn(async () => ({ kind: "not_found" as const })),
    loadSourcePreparation: vi.fn(async () => ({ kind: "not_found" as const })),
    recordWorkerHeartbeat: vi.fn(async () => ({ kind: "version_mismatch" as const })),
    recoverExpired: vi.fn(async () => []),
    ...overrides,
  };
}

describe("DeploymentJobReconciler", () => {
  it("recovers leases, creates missing work, and dispatches due identifiers", async () => {
    const store = createStore({
      ensureMissing: vi.fn(async () => [{ id: workItemId }] as never),
      listDispatchable: vi.fn(async () => [
        { contractVersion: 1, id: workItemId, kind: "deployment.claim" as const },
        {
          contractVersion: 1,
          id: sourceWorkItemId,
          kind: "deployment.prepare_source" as const,
        },
      ]),
      recoverExpired: vi.fn(async () => [
        {
          id: "22222222-2222-4222-8222-222222222222",
          status: "retry_wait" as const,
        },
        {
          id: "33333333-3333-4333-8333-333333333333",
          status: "dead_lettered" as const,
        },
      ]),
    });
    const enqueue = vi.fn(async () => ({ jobId: "stable-job-id" }));
    const metrics = new MetricsRegistry();
    const reconciler = new DeploymentJobReconciler({
      batchSize: 100,
      logger,
      maxAttempts: 5,
      metrics,
      publisher: { enqueue },
      store,
    });

    await expect(reconciler.runOnce()).resolves.toEqual({
      deadLettered: 1,
      dispatchFailed: 0,
      dispatched: 2,
      ensured: 1,
      recovered: 2,
    });
    expect(enqueue).toHaveBeenCalledWith({
      contractVersion: 1,
      kind: "deployment.claim",
      workItemId,
    });
    expect(metrics.renderPrometheus()).toContain("launchrail_worker_jobs_dispatched_total 2");
    expect(enqueue).toHaveBeenCalledWith({
      contractVersion: 1,
      kind: "deployment.prepare_source",
      workItemId: sourceWorkItemId,
    });
  });

  it("does not overlap reconciliation passes and preserves work after enqueue failure", async () => {
    let release: (() => void) | undefined;
    const listDispatchable = vi.fn(
      async () =>
        new Promise<readonly { contractVersion: 1; id: string; kind: "deployment.claim" }[]>(
          (resolve) => {
            release = () =>
              resolve([{ contractVersion: 1, id: workItemId, kind: "deployment.claim" }]);
          },
        ),
    );
    const store = createStore({ listDispatchable });
    const reconciler = new DeploymentJobReconciler({
      batchSize: 100,
      logger,
      maxAttempts: 5,
      publisher: {
        enqueue: vi.fn(async () => {
          throw new Error("redis unavailable");
        }),
      },
      store,
    });

    const first = reconciler.runOnce();
    const overlapping = reconciler.runOnce();
    await vi.waitFor(() => expect(listDispatchable).toHaveBeenCalledTimes(1));
    release?.();

    await expect(first).resolves.toMatchObject({ dispatchFailed: 1, dispatched: 0 });
    await expect(overlapping).resolves.toMatchObject({ dispatchFailed: 1, dispatched: 0 });
    expect(listDispatchable).toHaveBeenCalledTimes(1);
  });
});
