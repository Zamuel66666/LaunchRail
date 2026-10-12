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
  it("finalizes drained cancellations and continues dispatch when a cancellation fails", async () => {
    const cancellation = { deploymentId: workItemId, organizationId: sourceWorkItemId };
    const transition = vi.fn(async () => {
      throw new Error("fixture database unavailable");
    });
    const enqueue = vi.fn(async () => ({ jobId: workItemId }));
    const store = createStore({
      listPendingCancellations: vi.fn(async () => [cancellation]),
      listDispatchable: vi.fn(async () => [
        { id: workItemId, kind: "deployment.claim" as const, contractVersion: 1 as const },
      ]),
    });
    const reconciler = new DeploymentJobReconciler({
      batchSize: 10,
      logger,
      maxAttempts: 5,
      publisher: { enqueue },
      store,
      transitionStore: { transition, promote: vi.fn() },
    });
    await expect(reconciler.runOnce()).resolves.toMatchObject({
      dispatched: 1,
      resourceRecoveryFailures: 1,
    });
    expect(transition).toHaveBeenCalledWith({
      ...cancellation,
      to: "cancelled",
      idempotencyKey: `worker-cancelled-${workItemId}`,
    });
    expect(enqueue).toHaveBeenCalledOnce();
  });
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

    await expect(reconciler.runOnce()).resolves.toMatchObject({
      deadLettered: 1,
      dispatchFailed: 0,
      dispatched: 2,
      ensured: 1,
      lostRuntimesFailed: 0,
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

  it("fails missing durable runtimes but protects deployments with a live runtime lease", async () => {
    const lostRuntime = {
      containerId: "a".repeat(64),
      createdAt: new Date(),
      deploymentId: "55555555-5555-4555-8555-555555555555",
      hostPort: 40_001,
      id: "66666666-6666-4666-8666-666666666666",
      imageDigest: `sha256:${"b".repeat(64)}`,
      organizationId: "77777777-7777-4777-8777-777777777777",
      resourceMetadata: {},
    };
    const leasedRuntime = {
      ...lostRuntime,
      containerId: "c".repeat(64),
      deploymentId: "88888888-8888-4888-8888-888888888888",
      id: "99999999-9999-4999-8999-999999999999",
    };
    let routableRuntimes = [lostRuntime, leasedRuntime];
    const transition = vi.fn(async (command: { readonly deploymentId: string }) => {
      routableRuntimes = routableRuntimes.filter(
        (runtime) => runtime.deploymentId !== command.deploymentId,
      );
      return {} as never;
    });
    const routeReconcile = vi.fn(async () => undefined);
    const store = createStore({
      listRoutableRuntimes: vi.fn(async () => routableRuntimes),
      listWorkerResourceRecoveryState: vi.fn(async () => ({
        cleanupCheckoutKeys: [],
        cleanupContainerIds: [],
        knownContainerIds: [lostRuntime.containerId, leasedRuntime.containerId],
        knownImageIds: [],
        leasedBuildWorkItemIds: [],
        leasedCheckoutKeys: [],
        leasedRuntimeDeploymentIds: [leasedRuntime.deploymentId],
        leasedWorkItemIds: [],
      })),
    });
    const metrics = new MetricsRegistry();
    const reconciler = new DeploymentJobReconciler({
      batchSize: 100,
      logger,
      maxAttempts: 5,
      metrics,
      publisher: { enqueue: vi.fn(async () => ({ jobId: "stable-job-id" })) },
      routeManager: { reconcile: routeReconcile } as never,
      runtimeManager: { listManagedRuntimes: vi.fn(async () => []) } as never,
      store,
      transitionStore: { transition } as never,
    });

    await expect(reconciler.runOnce()).resolves.toMatchObject({ lostRuntimesFailed: 1 });
    expect(transition).toHaveBeenCalledWith({
      deploymentId: lostRuntime.deploymentId,
      failure: {
        category: "runtime_start_failed",
        message: "The active runtime is no longer present on the Docker host",
      },
      idempotencyKey: `worker-runtime-lost-${lostRuntime.deploymentId}`,
      organizationId: lostRuntime.organizationId,
      to: "deployment_failed",
    });
    expect(transition).not.toHaveBeenCalledWith(
      expect.objectContaining({ deploymentId: leasedRuntime.deploymentId }),
    );
    expect(routeReconcile).toHaveBeenCalledWith([
      expect.objectContaining({ deploymentId: leasedRuntime.deploymentId }),
    ]);
    expect(metrics.renderPrometheus()).toContain("launchrail_worker_lost_runtimes_failed_total 1");
  });
});
