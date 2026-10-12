import { randomUUID } from "node:crypto";
import { MetricsRegistry } from "@launchrail/observability";
import type { TraceHeaders } from "@launchrail/observability";
import type { DispatchableDeploymentJob } from "@launchrail/application";
import type { DeploymentJob } from "@launchrail/contracts";
import type { DeploymentJobProcessingOutcome } from "../src/processor.js";
import { expect, it, vi } from "vitest";
import { createStageHandoffHandler } from "../src/stage-handoff.js";

const job = { contractVersion: 1, kind: "deployment.claim", workItemId: randomUUID() } as const;
const next = { contractVersion: 1, kind: "deployment.prepare_source", id: randomUUID() } as const;
const fixture = () => ({
  processor: {
    process: vi.fn<
      (job: DeploymentJob, signal: AbortSignal) => Promise<DeploymentJobProcessingOutcome>
    >(async () => "completed"),
  },
  store: {
    listFollowupDispatchable: vi.fn<
      (workItemId: string) => Promise<readonly DispatchableDeploymentJob[]>
    >(async () => [next]),
  },
  publisher: {
    enqueue: vi.fn<(job: DeploymentJob, headers?: TraceHeaders) => Promise<void>>(
      async () => undefined,
    ),
  },
  logger: { warn: vi.fn() },
  metrics: new MetricsRegistry(),
});

it("publishes only the committed next-stage identifier and separate durable trace headers", async () => {
  const options = fixture();
  const traceParent = "00-1234567890abcdef1234567890abcdef-1234567890abcdef-01";
  options.store.listFollowupDispatchable.mockResolvedValue([{ ...next, traceParent }]);
  await createStageHandoffHandler(options)(job, new AbortController().signal);
  expect(options.store.listFollowupDispatchable).toHaveBeenCalledWith(job.workItemId);
  expect(options.publisher.enqueue).toHaveBeenCalledWith(
    { contractVersion: 1, kind: next.kind, workItemId: next.id },
    { traceparent: traceParent },
  );
  expect(options.metrics.renderPrometheus()).toContain(
    'stage_handoffs_total{kind="deployment.claim",outcome="published"} 1',
  );
});

it.each(["store", "publisher"])(
  "defers %s failure without failing committed work or logging raw exception data",
  async (failure) => {
    const options = fixture();
    if (failure === "store")
      options.store.listFollowupDispatchable.mockRejectedValue(new Error("PRIVATE_CANARY"));
    else options.publisher.enqueue.mockRejectedValue(new Error("PRIVATE_CANARY"));
    await expect(
      createStageHandoffHandler(options)(job, new AbortController().signal),
    ).resolves.toBeUndefined();
    expect(options.metrics.renderPrometheus()).toContain(
      'stage_handoffs_total{kind="deployment.claim",outcome="deferred"} 1',
    );
    expect(options.logger.warn).toHaveBeenCalled();
    expect(JSON.stringify(options.logger.warn.mock.calls)).not.toContain("PRIVATE_CANARY");
  },
);

it("keeps legacy wake-ups identifier-only without adding undefined telemetry fields", async () => {
  const options = fixture();
  await createStageHandoffHandler(options)(job, new AbortController().signal);
  expect(options.publisher.enqueue.mock.calls[0]).toEqual([
    { contractVersion: 1, kind: next.kind, workItemId: next.id },
  ]);
});

it("does not dispatch non-completed work, the final runtime stage, or aborted handlers", async () => {
  for (const outcome of ["retry_scheduled", "terminal", "interrupted", "dead_lettered"] as const) {
    const options = fixture();
    options.processor.process.mockResolvedValue(outcome);
    await createStageHandoffHandler(options)(job, new AbortController().signal);
    expect(options.store.listFollowupDispatchable).not.toHaveBeenCalled();
  }
  const options = fixture();
  await createStageHandoffHandler(options)(
    { ...job, kind: "deployment.start_runtime" },
    new AbortController().signal,
  );
  const aborted = new AbortController();
  aborted.abort();
  await createStageHandoffHandler(options)(job, aborted.signal);
  expect(options.publisher.enqueue).not.toHaveBeenCalled();
});

it("does not let broken diagnostics change a committed outcome", async () => {
  const options = fixture();
  options.publisher.enqueue.mockRejectedValue(new Error("private"));
  options.metrics.increment = () => {
    throw new Error("private metrics");
  };
  options.logger.warn.mockImplementation(() => {
    throw new Error("private logger");
  });
  await expect(
    createStageHandoffHandler(options)(job, new AbortController().signal),
  ).resolves.toBeUndefined();
});

it("leaves durable work to reconciliation if shutdown arrives during the next-stage read", async () => {
  const options = fixture();
  const controller = new AbortController();
  options.store.listFollowupDispatchable.mockImplementation(async () => {
    controller.abort();
    return [next];
  });
  await createStageHandoffHandler(options)(job, controller.signal);
  expect(options.publisher.enqueue).not.toHaveBeenCalled();
});

it("rejects malformed follow-up identities without copying them into logs or Redis", async () => {
  const options = fixture();
  options.store.listFollowupDispatchable.mockResolvedValue([{ ...next, id: "PRIVATE_CANARY" }]);
  await expect(
    createStageHandoffHandler(options)(job, new AbortController().signal),
  ).resolves.toBeUndefined();
  expect(options.publisher.enqueue).not.toHaveBeenCalled();
  expect(JSON.stringify(options.logger.warn.mock.calls)).not.toContain("PRIVATE_CANARY");
});
