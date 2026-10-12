import { describe, expect, it, vi } from "vitest";
import type { DeploymentRollbackStore } from "@launchrail/application";
import { DeploymentRollbackProcessor } from "../src/rollback-processor.js";

const runtimeInput = {
  deploymentId: "target",
  organizationId: "organization",
  projectId: "project",
  workItemId: "original-runtime-job",
  healthCheckPath: "/original-health",
  healthCheckPort: 3000,
  runtimeConfig: {
    cpuMillicores: 500,
    memoryMegabytes: 512,
    processLimit: 128,
    readOnlyRootFilesystem: true,
  },
  imageId: "sha256:image",
  imageReference: "launchrail:target",
  manifestDigest: "sha256:manifest",
  platform: "linux/amd64",
};
const lease = {
  id: "request",
  leaseToken: "lease",
  sourceDeploymentId: "current",
  runtime: runtimeInput,
};
const started = { containerId: "container", hostPort: 43001, resourceMetadata: {} };
function fixture(
  options: {
    unhealthy?: boolean;
    startFailure?: boolean;
    noWork?: boolean;
    graceMs?: number;
    timeoutMs?: number;
    stale?: boolean;
  } = {},
) {
  const store = {
    claim: vi.fn(async () => (options.noWork ? null : lease)),
    heartbeat: vi.fn(async () => true),
    finish: vi.fn(
      async (_command: Parameters<DeploymentRollbackStore["finish"]>[0]) => !options.stale,
    ),
  };
  const runtimeManager = {
    start: vi.fn(async () => {
      if (options.startFailure) throw new Error("CANARY_runtime_secret");
      return started;
    }),
    stop: vi.fn(),
    readLogs: vi.fn(),
  };
  const healthCheck = vi.fn(async () => ({
    statusCode: options.unhealthy ? 503 : 204,
    durationMs: 3.2,
  }));
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const processor = new DeploymentRollbackProcessor({
    store,
    runtimeManager,
    healthCheck,
    logger,
    workerId: "worker",
    leaseDurationMs: 1000,
    heartbeatIntervalMs: 10,
    jobTimeoutMs: options.timeoutMs ?? 200,
    healthGraceMs: options.graceMs ?? 0,
  });
  return { processor, store, runtimeManager, healthCheck, logger };
}
describe("Health-gated rollback preparation", () => {
  it("adopts or recreates with the original identity and checks before completion", async () => {
    const f = fixture();
    await f.processor.runOnce();
    expect(f.runtimeManager.start).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: {
          deploymentId: "target",
          organizationId: "organization",
          projectId: "project",
          workItemId: "original-runtime-job",
        },
        runtimeConfig: runtimeInput.runtimeConfig,
        image: runtimeInput,
      }),
    );
    expect(f.healthCheck).toHaveBeenCalledWith(
      expect.objectContaining({ port: 43001, path: "/original-health" }),
    );
    expect(f.store.finish).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({
          healthStatusCode: 204,
          healthDurationMs: 3,
          runtime: expect.objectContaining({ imageDigest: "sha256:manifest" }),
        }),
      }),
    );
    expect(f.runtimeManager.start.mock.invocationCallOrder[0]).toBeLessThan(
      f.healthCheck.mock.invocationCallOrder[0]!,
    );
    expect(f.healthCheck.mock.invocationCallOrder[0]).toBeLessThan(
      f.store.finish.mock.invocationCallOrder[0]!,
    );
    expect(f.processor.getActiveJobCount()).toBe(0);
  });
  it("retains current release intent and records an unhealthy target for durable cleanup", async () => {
    const f = fixture({ unhealthy: true });
    await f.processor.runOnce();
    expect(f.store.finish).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({
          errorCode: "rollback_unhealthy",
          runtime: { ...started, imageDigest: "sha256:manifest" },
        }),
      }),
    );
    expect(f.runtimeManager.stop).not.toHaveBeenCalled();
  });
  it("does not stop a runtime now owned by a replacement lease", async () => {
    const f = fixture({ stale: true });
    await f.processor.runOnce();
    expect(f.runtimeManager.stop).not.toHaveBeenCalled();
    expect(f.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "rollback_completion_fenced" }),
      expect.any(String),
    );
  });
  it("classifies startup failure without persisting or logging adapter error text", async () => {
    const f = fixture({ startFailure: true });
    await f.processor.runOnce();
    expect(f.store.finish).toHaveBeenCalledWith(
      expect.objectContaining({ result: { errorCode: "rollback_infrastructure_unavailable" } }),
    );
    expect(JSON.stringify(f.logger.warn.mock.calls)).not.toContain("CANARY");
  });
  it("bounds startup grace and heartbeats while retaining the current release", async () => {
    const f = fixture({ graceMs: 100, timeoutMs: 25 });
    await f.processor.runOnce();
    expect(f.store.heartbeat).toHaveBeenCalled();
    expect(f.healthCheck).not.toHaveBeenCalled();
    expect(f.store.finish).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({ errorCode: "rollback_infrastructure_unavailable" }),
      }),
    );
  });
  it("deduplicates in-flight reconciliation and handles an empty durable queue", async () => {
    const f = fixture({ noWork: true });
    const first = f.processor.runOnce();
    expect(f.processor.runOnce()).toBe(first);
    await first;
    expect(f.store.claim).toHaveBeenCalledOnce();
    expect(f.runtimeManager.start).not.toHaveBeenCalled();
  });
  it("does not misreport passing health when activation persistence fails", async () => {
    const f = fixture();
    f.store.finish.mockRejectedValueOnce(new Error("CANARY_database_exception"));
    await f.processor.runOnce();
    expect(f.store.finish.mock.calls[1]?.[0]).toMatchObject({
      result: { errorCode: "rollback_infrastructure_unavailable" },
    });
    expect(f.store.finish.mock.calls[1]?.[0].result).not.toHaveProperty("healthFailure");
    expect(JSON.stringify(f.logger.warn.mock.calls)).not.toContain("CANARY");
  });
});
