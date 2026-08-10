import type { DeploymentJobStore } from "@launchrail/application";
import { describe, expect, it, vi } from "vitest";

import { DeploymentJobReconciler } from "../src/reconciler.js";
import type { WorkerEventLogger } from "../src/processor.js";

const workItemId = "11111111-1111-4111-8111-111111111111";

const logger: WorkerEventLogger = {
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
};

function createStore(overrides: Partial<DeploymentJobStore> = {}): DeploymentJobStore {
  return {
    claim: vi.fn(async () => ({ kind: "not_found" as const })),
    completeClaimTransition: vi.fn(async () => ({ kind: "not_found" as const })),
    ensureMissingClaims: vi.fn(async () => []),
    ensurePendingClaim: vi.fn(async () => ({ kind: "deployment_not_found" as const })),
    fail: vi.fn(async () => ({ kind: "not_found" as const })),
    heartbeat: vi.fn(async () => ({ kind: "not_found" as const })),
    listDispatchable: vi.fn(async () => []),
    listWorkerHeartbeats: vi.fn(async () => []),
    recordWorkerHeartbeat: vi.fn(async () => ({ kind: "version_mismatch" as const })),
    recoverExpired: vi.fn(async () => []),
    ...overrides,
  };
}

describe("DeploymentJobReconciler", () => {
  it("recovers leases, creates missing work, and dispatches due identifiers", async () => {
    const store = createStore({
      ensureMissingClaims: vi.fn(async () => [{ id: workItemId }] as never),
      listDispatchable: vi.fn(async () => [
        { contractVersion: 1, id: workItemId, kind: "deployment.claim" as const },
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
    const reconciler = new DeploymentJobReconciler({
      batchSize: 100,
      logger,
      maxAttempts: 5,
      publisher: { enqueue },
      store,
    });

    await expect(reconciler.runOnce()).resolves.toEqual({
      deadLettered: 1,
      dispatchFailed: 0,
      dispatched: 1,
      ensured: 1,
      recovered: 2,
    });
    expect(enqueue).toHaveBeenCalledWith({
      contractVersion: 1,
      kind: "deployment.claim",
      workItemId,
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
