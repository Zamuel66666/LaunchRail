import type {
  ClaimDeploymentJobResult,
  CompleteDeploymentClaimTransitionResult,
  DeploymentJobLease,
  DeploymentJobStore,
  HeartbeatDeploymentJobResult,
} from "@launchrail/application";
import { describe, expect, it, vi } from "vitest";

import { DeploymentClaimProcessor, type WorkerEventLogger } from "../src/processor.js";

const workItemId = "11111111-1111-4111-8111-111111111111";
const deploymentId = "22222222-2222-4222-8222-222222222222";
const organizationId = "33333333-3333-4333-8333-333333333333";
const now = new Date("2026-08-10T12:00:00.000Z");

const lease: DeploymentJobLease = {
  attemptCount: 1,
  deploymentId,
  kind: "deployment.claim",
  leaseExpiresAt: new Date(now.getTime() + 60_000),
  leaseToken: "44444444-4444-4444-8444-444444444444",
  organizationId,
  workItemId,
};

function createLogger(): WorkerEventLogger & { readonly records: unknown[] } {
  const records: unknown[] = [];
  return {
    error: (bindings, message) => records.push({ bindings, message }),
    info: (bindings, message) => records.push({ bindings, message }),
    records,
    warn: (bindings, message) => records.push({ bindings, message }),
  };
}

function createStore(overrides: Partial<DeploymentJobStore> = {}): DeploymentJobStore {
  return {
    appendBuildLogs: vi.fn(async () => ({ kind: "not_found" as const })),
    claim: vi.fn(async () => ({ kind: "claimed" as const, lease })),
    completeBuild: vi.fn(async () => ({ kind: "not_found" as const })),
    completeClaimTransition: vi.fn(async () => ({
      kind: "completed" as const,
      transition: {
        deploymentId,
        eventSequence: 1,
        from: "queued" as const,
        idempotentReplay: false,
        to: "cloning" as const,
        version: 2,
      },
    })),
    completeSourcePreparation: vi.fn(async () => ({ kind: "not_found" as const })),
    ensureMissing: vi.fn(async () => []),
    ensureMissingClaims: vi.fn(async () => []),
    ensurePendingClaim: vi.fn(async () => ({ kind: "deployment_not_found" as const })),
    fail: vi.fn(async () => ({
      attemptCount: 1,
      availableAt: now,
      kind: "retry_scheduled" as const,
    })),
    failBuild: vi.fn(async () => ({ kind: "not_found" as const })),
    failSourcePreparation: vi.fn(async () => ({ kind: "not_found" as const })),
    heartbeat: vi.fn(async () => ({
      kind: "extended" as const,
      leaseExpiresAt: lease.leaseExpiresAt,
    })),
    listDispatchable: vi.fn(async () => []),
    listWorkerHeartbeats: vi.fn(async () => []),
    loadBuildInput: vi.fn(async () => ({ kind: "not_found" as const })),
    loadSourcePreparation: vi.fn(async () => ({ kind: "not_found" as const })),
    recordWorkerHeartbeat: vi.fn(async () => ({ kind: "version_mismatch" as const })),
    recoverExpired: vi.fn(async () => []),
    ...overrides,
  };
}

function createProcessor(
  store: DeploymentJobStore,
  logger = createLogger(),
): DeploymentClaimProcessor {
  return new DeploymentClaimProcessor({
    backoffBaseMs: 1_000,
    backoffCapMs: 60_000,
    heartbeatIntervalMs: 1_000,
    jobTimeoutMs: 100,
    leaseDurationMs: 60_000,
    logger,
    store,
    workerId: "worker-test",
  });
}

const job = { contractVersion: 1, kind: "deployment.claim", workItemId } as const;

describe("DeploymentClaimProcessor", () => {
  it("claims and atomically applies the stable transition with completion", async () => {
    const completeClaimTransition = vi.fn(async () => ({
      kind: "completed" as const,
      transition: {
        deploymentId,
        eventSequence: 1,
        from: "queued" as const,
        idempotentReplay: false,
        to: "cloning" as const,
        version: 2,
      },
    }));
    const store = createStore({ completeClaimTransition });
    const processor = createProcessor(store);

    await expect(processor.process(job, new AbortController().signal)).resolves.toBe("completed");
    expect(store.claim).toHaveBeenCalledWith({
      expectedKind: "deployment.claim",
      leaseDurationMs: 60_000,
      workerId: "worker-test",
      workItemId,
    });
    expect(completeClaimTransition).toHaveBeenCalledWith({
      leaseToken: lease.leaseToken,
      workItemId,
    });
    expect(processor.getActiveJobCount()).toBe(0);
  });

  it.each(["completed", "dead_lettered"] as const)(
    "treats a duplicate %s delivery as terminal without repeating the effect",
    async (kind) => {
      const store = createStore({ claim: vi.fn(async () => ({ kind })) });
      const processor = createProcessor(store);

      await expect(processor.process(job, new AbortController().signal)).resolves.toBe("terminal");
      expect(store.completeClaimTransition).not.toHaveBeenCalled();
    },
  );

  it("persists a deterministic safe retry without exposing the thrown error", async () => {
    const canary = "phase-five-canary-private-token";
    const logger = createLogger();
    const fail = vi.fn(async () => ({
      attemptCount: 1,
      availableAt: new Date(now.getTime() + 1_000),
      kind: "retry_scheduled" as const,
    }));
    const store = createStore({
      completeClaimTransition: vi.fn(async () => {
        throw new Error(canary);
      }),
      fail,
    });
    const processor = createProcessor(store, logger);

    await expect(processor.process(job, new AbortController().signal)).resolves.toBe(
      "retry_scheduled",
    );
    expect(fail).toHaveBeenCalledWith({
      leaseToken: lease.leaseToken,
      retryDelayMs: expect.any(Number),
      safeErrorCode: "worker_step_failed",
      safeErrorMessage: "Deployment claim could not complete and is safe to retry",
      workItemId,
    });
    expect(JSON.stringify(logger.records)).not.toContain(canary);
    expect(JSON.stringify(fail.mock.calls)).not.toContain(canary);
  });

  it("bounds a non-cooperative atomic operation without racing a failure write", async () => {
    const store = createStore({
      completeClaimTransition: vi.fn(() => new Promise<never>(() => undefined)),
    });
    const processor = new DeploymentClaimProcessor({
      backoffBaseMs: 1,
      backoffCapMs: 1,
      heartbeatIntervalMs: 1_000,
      jobTimeoutMs: 5,
      leaseDurationMs: 60_000,
      logger: createLogger(),
      store,
      workerId: "worker-test",
    });

    await expect(processor.process(job, new AbortController().signal)).resolves.toBe("interrupted");
    expect(store.fail).not.toHaveBeenCalled();
    expect(processor.getActiveJobCount()).toBe(1);
  });

  it("bounds a claim that never reaches authoritative storage", async () => {
    const store = createStore({
      claim: vi.fn(() => new Promise<never>(() => undefined)),
    });
    const processor = new DeploymentClaimProcessor({
      backoffBaseMs: 1,
      backoffCapMs: 1,
      heartbeatIntervalMs: 1_000,
      jobTimeoutMs: 5,
      leaseDurationMs: 60_000,
      logger: createLogger(),
      store,
      workerId: "worker-test",
    });

    await expect(processor.process(job, new AbortController().signal)).resolves.toBe(
      "infrastructure_unavailable",
    );
    expect(store.fail).not.toHaveBeenCalled();
    expect(processor.getActiveJobCount()).toBe(1);
  });

  it("tracks a timed-out claim until the database operation actually settles", async () => {
    let release: (() => void) | undefined;
    const claim = new Promise<ClaimDeploymentJobResult>((resolve) => {
      release = () => resolve({ kind: "not_found" });
    });
    const store = createStore({ claim: vi.fn(() => claim) });
    const processor = new DeploymentClaimProcessor({
      backoffBaseMs: 1,
      backoffCapMs: 1,
      heartbeatIntervalMs: 1_000,
      jobTimeoutMs: 5,
      leaseDurationMs: 60_000,
      logger: createLogger(),
      store,
      workerId: "worker-test",
    });

    await expect(processor.process(job, new AbortController().signal)).resolves.toBe(
      "infrastructure_unavailable",
    );
    expect(processor.getActiveJobCount()).toBe(1);

    const idle = processor.waitForIdle();
    release?.();
    await idle;
    expect(processor.getActiveJobCount()).toBe(0);
  });

  it("keeps a timed-out authoritative operation active until it actually settles", async () => {
    let release: (() => void) | undefined;
    const completion = new Promise<CompleteDeploymentClaimTransitionResult>((resolve) => {
      release = () =>
        resolve({
          kind: "completed",
          transition: {
            deploymentId,
            eventSequence: 1,
            from: "queued",
            idempotentReplay: false,
            to: "cloning",
            version: 2,
          },
        });
    });
    const store = createStore({ completeClaimTransition: vi.fn(() => completion) });
    const processor = new DeploymentClaimProcessor({
      backoffBaseMs: 1,
      backoffCapMs: 1,
      heartbeatIntervalMs: 1_000,
      jobTimeoutMs: 5,
      leaseDurationMs: 60_000,
      logger: createLogger(),
      store,
      workerId: "worker-test",
    });

    await expect(processor.process(job, new AbortController().signal)).resolves.toBe("interrupted");
    expect(processor.getActiveJobCount()).toBe(1);
    expect(store.fail).not.toHaveBeenCalled();

    const idle = processor.waitForIdle();
    release?.();
    await idle;
    expect(processor.getActiveJobCount()).toBe(0);
    expect(store.fail).not.toHaveBeenCalled();
  });

  it("does not report idle while a final lease heartbeat is still in flight", async () => {
    let releaseCompletion: (() => void) | undefined;
    let releaseHeartbeat: (() => void) | undefined;
    const completion = new Promise<CompleteDeploymentClaimTransitionResult>((resolve) => {
      releaseCompletion = () =>
        resolve({
          kind: "completed",
          transition: {
            deploymentId,
            eventSequence: 1,
            from: "queued",
            idempotentReplay: false,
            to: "cloning",
            version: 2,
          },
        });
    });
    const heartbeat = new Promise<HeartbeatDeploymentJobResult>((resolve) => {
      releaseHeartbeat = () => resolve({ kind: "not_running", status: "completed" });
    });
    const heartbeatCall = vi.fn(() => heartbeat);
    const store = createStore({
      completeClaimTransition: vi.fn(() => completion),
      heartbeat: heartbeatCall,
    });
    const processor = new DeploymentClaimProcessor({
      backoffBaseMs: 1,
      backoffCapMs: 1,
      heartbeatIntervalMs: 1,
      jobTimeoutMs: 5_000,
      leaseDurationMs: 60_000,
      logger: createLogger(),
      store,
      workerId: "worker-test",
    });

    const shutdown = new AbortController();
    const processing = processor.process(job, shutdown.signal);
    await vi.waitFor(() => expect(heartbeatCall).toHaveBeenCalledOnce());
    shutdown.abort();
    await expect(processing).resolves.toBe("interrupted");
    expect(processor.getActiveJobCount()).toBe(1);

    releaseCompletion?.();
    await Promise.resolve();
    expect(processor.getActiveJobCount()).toBe(1);

    const idle = processor.waitForIdle();
    releaseHeartbeat?.();
    await idle;
    expect(processor.getActiveJobCount()).toBe(0);
  });

  it("settles the final heartbeat before returning a fenced completion", async () => {
    let releaseCompletion: (() => void) | undefined;
    let releaseHeartbeat: (() => void) | undefined;
    const completion = new Promise<CompleteDeploymentClaimTransitionResult>((resolve) => {
      releaseCompletion = () => resolve({ kind: "lease_expired" });
    });
    const heartbeat = new Promise<HeartbeatDeploymentJobResult>((resolve) => {
      releaseHeartbeat = () => resolve({ kind: "lease_expired" });
    });
    const heartbeatCall = vi.fn(() => heartbeat);
    const store = createStore({
      completeClaimTransition: vi.fn(() => completion),
      heartbeat: heartbeatCall,
    });
    const processor = new DeploymentClaimProcessor({
      backoffBaseMs: 1,
      backoffCapMs: 1,
      heartbeatIntervalMs: 1,
      jobTimeoutMs: 1_000,
      leaseDurationMs: 60_000,
      logger: createLogger(),
      store,
      workerId: "worker-test",
    });

    let settled = false;
    const processing = processor.process(job, new AbortController().signal).finally(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(heartbeatCall).toHaveBeenCalledOnce());
    releaseCompletion?.();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(settled).toBe(false);
    expect(processor.getActiveJobCount()).toBe(1);

    releaseHeartbeat?.();
    await expect(processing).resolves.toBe("interrupted");
    expect(processor.getActiveJobCount()).toBe(0);
  });

  it("leaves an interrupted lease recoverable during shutdown", async () => {
    const store = createStore({
      completeClaimTransition: vi.fn(() => new Promise<never>(() => undefined)),
    });
    const shutdown = new AbortController();
    const processor = createProcessor(store);

    const processing = processor.process(job, shutdown.signal);
    await vi.waitFor(() => expect(processor.getActiveJobCount()).toBe(1));
    shutdown.abort();

    await expect(processing).resolves.toBe("interrupted");
    expect(store.fail).not.toHaveBeenCalled();
    expect(processor.getActiveJobCount()).toBe(1);
  });
});
