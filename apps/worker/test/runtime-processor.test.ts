import { HttpHealthCheckError } from "@launchrail/runtime";
import { describe, expect, it, vi } from "vitest";

import { DeploymentRuntimeProcessor } from "../src/runtime-processor.js";

const workItemId = "11111111-1111-4111-8111-111111111111";
const deploymentId = "22222222-2222-4222-8222-222222222222";
const organizationId = "33333333-3333-4333-8333-333333333333";
const projectId = "44444444-4444-4444-8444-444444444444";
const leaseToken = "runtime-lease-token";
const job = {
  contractVersion: 1,
  kind: "deployment.start_runtime",
  workItemId,
} as const;
const lease = {
  attemptCount: 1,
  deploymentId,
  kind: "deployment.start_runtime",
  leaseExpiresAt: new Date(Date.now() + 60_000),
  leaseToken,
  organizationId,
  workItemId,
};
const runtime = {
  deploymentId,
  healthCheckPath: "/health",
  healthCheckPort: 3000,
  imageId: "sha256:image",
  imageReference: "launchrail:test",
  manifestDigest: `sha256:${"a".repeat(64)}`,
  organizationId,
  platform: "linux/amd64",
  projectId,
  runtimeConfig: {
    cpuMillicores: 500,
    memoryMegabytes: 512,
    processLimit: 64,
    readOnlyRootFilesystem: true,
  },
  workItemId,
};

function createProcessor(
  healthCheck: () => Promise<{ durationMs: number; statusCode: number }>,
  healthGraceMs = 0,
) {
  const check = vi.fn(healthCheck);
  const recordHealthCheck = vi.fn(async () => undefined);
  const failRuntime = vi.fn(async () => ({
    attemptCount: 1,
    kind: "dead_lettered" as const,
    transition: {} as never,
  }));
  const stop = vi.fn(async (_command: { readonly signal: AbortSignal }) => undefined);
  const promote = vi.fn(async () => ({}) as never);
  const start = vi.fn(async () => ({
    containerId: "a".repeat(64),
    hostPort: 40_000,
    resourceMetadata: {},
  }));
  const processor = new DeploymentRuntimeProcessor({
    backoffBaseMs: 100,
    backoffCapMs: 1_000,
    heartbeatIntervalMs: 60_000,
    healthCheck: check as never,
    healthGraceMs,
    jobTimeoutMs: 10_000,
    leaseDurationMs: 60_000,
    logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    runtimeManager: {
      start,
      stop,
    } as never,
    store: {
      claim: vi.fn(async () => ({ kind: "claimed" as const, lease })),
      completeRuntime: vi.fn(async () => ({
        kind: "completed" as const,
        runtime: {} as never,
        transition: {} as never,
      })),
      failRuntime,
      loadRuntimeInput: vi.fn(async () => ({ kind: "loaded" as const, runtime })),
      recordHealthCheck,
    } as never,
    transitionStore: {
      promote,
      transition: vi.fn(async () => ({}) as never),
    },
    workerId: "worker-test",
  });
  return { check, failRuntime, processor, promote, recordHealthCheck, start, stop };
}

describe("DeploymentRuntimeProcessor health gate", () => {
  it("records unhealthy HTTP responses, stops the candidate, and fails without retry", async () => {
    const { failRuntime, processor, promote, recordHealthCheck, stop } = createProcessor(
      async () => ({ durationMs: 12, statusCode: 503 }),
    );

    await expect(processor.process(job, new AbortController().signal)).resolves.toBe(
      "dead_lettered",
    );

    expect(recordHealthCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        deploymentId,
        organizationId,
        outcome: "failed",
        statusCode: 503,
        durationMs: 12,
      }),
    );
    expect(stop).toHaveBeenCalledOnce();
    expect(failRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        failure: { category: "health_unhealthy", message: "Health check returned HTTP 503" },
        retryable: false,
      }),
    );
    expect(promote).not.toHaveBeenCalled();
  });

  it("keeps health timeouts distinct from runtime startup failures", async () => {
    const { failRuntime, processor, recordHealthCheck, stop } = createProcessor(async () => {
      throw new HttpHealthCheckError("health_timeout", 25);
    });

    await expect(processor.process(job, new AbortController().signal)).resolves.toBe(
      "dead_lettered",
    );
    expect(recordHealthCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "failed",
        statusCode: null,
        durationMs: 25,
      }),
    );
    expect(stop).toHaveBeenCalledOnce();
    expect(failRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        failure: {
          category: "health_timeout",
          message: "The health check exceeded its time limit",
        },
        retryable: false,
      }),
    );
  });

  it("records a passed check before completing and promoting the release", async () => {
    const { failRuntime, processor, promote, recordHealthCheck, stop } = createProcessor(
      async () => ({ durationMs: 4, statusCode: 204 }),
    );

    await expect(processor.process(job, new AbortController().signal)).resolves.toBe("completed");

    expect(recordHealthCheck).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "passed", statusCode: 204 }),
    );
    expect(stop).not.toHaveBeenCalled();
    expect(failRuntime).not.toHaveBeenCalled();
    expect(promote).toHaveBeenCalledWith(expect.objectContaining({ deploymentId, organizationId }));
  });

  it("waits for the configured startup grace period before probing the candidate", async () => {
    const startedAt = Date.now();
    let checkedAt = 0;
    const { processor } = createProcessor(async () => {
      checkedAt = Date.now();
      return { durationMs: 1, statusCode: 204 };
    }, 30);

    await expect(processor.process(job, new AbortController().signal)).resolves.toBe("completed");

    expect(checkedAt - startedAt).toBeGreaterThanOrEqual(25);
  });

  it("cleans up the candidate when interrupted during startup grace without probing or promoting", async () => {
    const controller = new AbortController();
    const { check, failRuntime, processor, promote, recordHealthCheck, start, stop } =
      createProcessor(async () => ({ durationMs: 1, statusCode: 204 }), 10_000);
    const processing = processor.process(job, controller.signal);

    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    controller.abort(new Error("Worker is shutting down"));

    await expect(processing).resolves.toBe("interrupted");
    expect(check).not.toHaveBeenCalled();
    expect(recordHealthCheck).not.toHaveBeenCalled();
    expect(failRuntime).not.toHaveBeenCalled();
    expect(promote).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledOnce();
    expect(stop.mock.calls[0]?.[0].signal.aborted).toBe(false);
  });
});
