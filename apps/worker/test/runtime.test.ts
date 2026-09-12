import type { DeploymentJobStore, RecordWorkerHeartbeatCommand } from "@launchrail/application";
import { describe, expect, it, vi } from "vitest";

import type { WorkerEventLogger } from "../src/processor.js";
import { DeploymentWorkerRuntime } from "../src/runtime.js";

const logger: WorkerEventLogger = {
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
};

function createHeartbeatStore(statuses: string[]): DeploymentJobStore {
  const recordedAt = new Date();
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
    recordWorkerHeartbeat: vi.fn(async (command: RecordWorkerHeartbeatCommand) => {
      statuses.push(command.status);
      return {
        kind: statuses.length === 1 ? ("created" as const) : ("updated" as const),
        worker: {
          activeJobCount: command.activeJobCount,
          freshness: command.status === "stopped" ? ("stopped" as const) : ("fresh" as const),
          heartbeatAt: recordedAt,
          startedAt: recordedAt,
          status: command.status,
          stoppedAt: command.status === "stopped" ? recordedAt : null,
          version: command.version,
          workerId: command.workerId,
        },
      };
    }),
    recoverExpired: vi.fn(async () => []),
  };
}

describe("DeploymentWorkerRuntime", () => {
  it("starts dependencies, reconciles, and records the full graceful lifecycle", async () => {
    const statuses: string[] = [];
    const calls: string[] = [];
    const runtime = new DeploymentWorkerRuntime({
      consumer: {
        cancelActive: vi.fn(() => calls.push("cancel")),
        close: vi.fn(async () => void calls.push("consumer.close")),
        drain: vi.fn(async () => void calls.push("drain")),
        pause: vi.fn(async () => void calls.push("pause")),
        start: vi.fn(() => calls.push("consumer.start")),
        waitUntilReady: vi.fn(async () => void calls.push("consumer.ready")),
      },
      heartbeatIntervalMs: 60_000,
      logger,
      processor: {
        getActiveJobCount: () => 0,
        waitForIdle: vi.fn(async () => undefined),
      } as never,
      publisher: {
        close: vi.fn(async () => void calls.push("publisher.close")),
        waitUntilReady: vi.fn(async () => void calls.push("publisher.ready")),
      },
      reconciliationIntervalMs: 60_000,
      reconciler: {
        runOnce: vi.fn(async () => {
          calls.push("reconcile");
          return {
            deadLettered: 0,
            dispatchFailed: 0,
            dispatched: 0,
            ensured: 0,
            recovered: 0,
          };
        }),
        waitForIdle: vi.fn(async () => undefined),
      } as never,
      shutdownGraceMs: 100,
      store: createHeartbeatStore(statuses),
      version: "0.1.0",
      workerId: "worker-test",
    });

    await runtime.start();
    await runtime.stop();

    expect(statuses).toEqual(["starting", "ready", "draining", "stopped"]);
    expect(calls).toEqual([
      "publisher.ready",
      "consumer.ready",
      "reconcile",
      "consumer.start",
      "pause",
      "drain",
      "consumer.close",
      "publisher.close",
    ]);
    expect(runtime.getState()).toBe("stopped");
  });

  it("returns at the shutdown deadline even when active work never settles", async () => {
    vi.useFakeTimers();
    try {
      const statuses: string[] = [];
      const cancelActive = vi.fn();
      const close = vi.fn(async () => undefined);
      const runtime = new DeploymentWorkerRuntime({
        consumer: {
          cancelActive,
          close,
          drain: vi.fn(async () => new Promise<void>(() => undefined)),
          pause: vi.fn(async () => undefined),
          start: vi.fn(),
          waitUntilReady: vi.fn(async () => undefined),
        },
        heartbeatIntervalMs: 60_000,
        logger,
        processor: {
          getActiveJobCount: () => 1,
          waitForIdle: vi.fn(async () => new Promise<void>(() => undefined)),
        } as never,
        publisher: {
          close: vi.fn(async () => undefined),
          waitUntilReady: vi.fn(async () => undefined),
        },
        reconciliationIntervalMs: 60_000,
        reconciler: {
          runOnce: vi.fn(async () => ({
            deadLettered: 0,
            dispatchFailed: 0,
            dispatched: 0,
            ensured: 0,
            recovered: 0,
          })),
          waitForIdle: vi.fn(async () => undefined),
        } as never,
        shutdownGraceMs: 25,
        store: createHeartbeatStore(statuses),
        version: "0.1.0",
        workerId: "worker-test",
      });
      await runtime.start();

      const stopping = runtime.stop();
      await vi.advanceTimersByTimeAsync(25);
      await stopping;

      expect(cancelActive).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledWith(true);
      expect(statuses).toEqual(["starting", "ready", "draining"]);
      expect(runtime.getState()).toBe("stopped");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not persist stopped when the consumer drains before processor work becomes idle", async () => {
    vi.useFakeTimers();
    try {
      const statuses: string[] = [];
      const close = vi.fn(async () => undefined);
      const waitForIdle = vi.fn(async () => new Promise<void>(() => undefined));
      const runtime = new DeploymentWorkerRuntime({
        consumer: {
          cancelActive: vi.fn(),
          close,
          drain: vi.fn(async () => undefined),
          pause: vi.fn(async () => undefined),
          start: vi.fn(),
          waitUntilReady: vi.fn(async () => undefined),
        },
        heartbeatIntervalMs: 60_000,
        logger,
        processor: { getActiveJobCount: () => 1, waitForIdle } as never,
        publisher: {
          close: vi.fn(async () => undefined),
          waitUntilReady: vi.fn(async () => undefined),
        },
        reconciliationIntervalMs: 60_000,
        reconciler: {
          runOnce: vi.fn(async () => ({
            deadLettered: 0,
            dispatchFailed: 0,
            dispatched: 0,
            ensured: 0,
            recovered: 0,
          })),
          waitForIdle: vi.fn(async () => undefined),
        } as never,
        shutdownGraceMs: 25,
        store: createHeartbeatStore(statuses),
        version: "0.1.0",
        workerId: "worker-background-operation-test",
      });
      await runtime.start();

      const stopping = runtime.stop();
      await vi.advanceTimersByTimeAsync(25);
      await stopping;

      expect(waitForIdle).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledWith(true);
      expect(statuses).toEqual(["starting", "ready", "draining"]);
      expect(runtime.getState()).toBe("stopped");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops within the deadline when startup readiness never settles", async () => {
    const statuses: string[] = [];
    let markReadinessStarted: (() => void) | undefined;
    const readinessStarted = new Promise<void>((resolve) => {
      markReadinessStarted = resolve;
    });
    const startConsumer = vi.fn();
    const closeConsumer = vi.fn(async () => undefined);
    const closePublisher = vi.fn(async () => undefined);
    const runtime = new DeploymentWorkerRuntime({
      consumer: {
        cancelActive: vi.fn(),
        close: closeConsumer,
        drain: vi.fn(async () => undefined),
        pause: vi.fn(async () => undefined),
        start: startConsumer,
        waitUntilReady: vi.fn(async () => undefined),
      },
      heartbeatIntervalMs: 60_000,
      logger,
      processor: {
        getActiveJobCount: () => 0,
        waitForIdle: vi.fn(async () => undefined),
      } as never,
      publisher: {
        close: closePublisher,
        waitUntilReady: vi.fn(
          async () =>
            new Promise<void>(() => {
              markReadinessStarted?.();
            }),
        ),
      },
      reconciliationIntervalMs: 60_000,
      reconciler: {
        runOnce: vi.fn(async () => ({
          deadLettered: 0,
          dispatchFailed: 0,
          dispatched: 0,
          ensured: 0,
          recovered: 0,
        })),
        waitForIdle: vi.fn(async () => undefined),
      } as never,
      shutdownGraceMs: 25,
      store: createHeartbeatStore(statuses),
      version: "0.1.0",
      workerId: "worker-startup-test",
    });

    const starting = runtime.start();
    void starting.catch(() => undefined);
    await readinessStarted;
    await runtime.stop();

    expect(startConsumer).not.toHaveBeenCalled();
    expect(closeConsumer).toHaveBeenCalledWith(true);
    expect(closePublisher).toHaveBeenCalledOnce();
    expect(runtime.getState()).toBe("stopped");
  });

  it("coalesces stalled periodic work instead of building an unbounded backlog", async () => {
    vi.useFakeTimers();
    try {
      const statuses: string[] = [];
      const baseStore = createHeartbeatStore(statuses);
      const recordWorkerHeartbeat = vi.fn(baseStore.recordWorkerHeartbeat.bind(baseStore));
      const stalledHeartbeat = new Promise<never>(() => undefined);
      recordWorkerHeartbeat.mockImplementation((command) =>
        recordWorkerHeartbeat.mock.calls.length <= 2
          ? baseStore.recordWorkerHeartbeat(command)
          : stalledHeartbeat,
      );
      const store = { ...baseStore, recordWorkerHeartbeat };
      const reconciliationResult = {
        deadLettered: 0,
        dispatchFailed: 0,
        dispatched: 0,
        ensured: 0,
        recovered: 0,
      };
      const stalledReconciliation = new Promise<never>(() => undefined);
      const runOnce = vi
        .fn()
        .mockResolvedValueOnce(reconciliationResult)
        .mockImplementation(() => stalledReconciliation);
      const runtime = new DeploymentWorkerRuntime({
        consumer: {
          cancelActive: vi.fn(),
          close: vi.fn(async () => undefined),
          drain: vi.fn(async () => undefined),
          pause: vi.fn(async () => undefined),
          start: vi.fn(),
          waitUntilReady: vi.fn(async () => undefined),
        },
        heartbeatIntervalMs: 1,
        logger,
        processor: {
          getActiveJobCount: () => 0,
          waitForIdle: vi.fn(async () => undefined),
        } as never,
        publisher: {
          close: vi.fn(async () => undefined),
          waitUntilReady: vi.fn(async () => undefined),
        },
        reconciliationIntervalMs: 1,
        reconciler: {
          runOnce,
          waitForIdle: vi.fn(() => stalledReconciliation),
        } as never,
        shutdownGraceMs: 25,
        store,
        version: "0.1.0",
        workerId: "worker-coalescing-test",
      });
      await runtime.start();

      await vi.advanceTimersByTimeAsync(20);

      expect(recordWorkerHeartbeat).toHaveBeenCalledTimes(3);
      expect(runOnce).toHaveBeenCalledTimes(2);

      const stopping = runtime.stop();
      await vi.advanceTimersByTimeAsync(25);
      await stopping;
      expect(runtime.getState()).toBe("stopped");
    } finally {
      vi.useRealTimers();
    }
  });
});
