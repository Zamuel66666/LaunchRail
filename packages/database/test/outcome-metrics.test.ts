import { MetricsRegistry } from "@launchrail/observability";
import { describe, expect, it, vi } from "vitest";
import { recordDeploymentOutcome } from "../src/outcome-metrics.js";

const transition = {
  deploymentId: "CANARY_private_deployment_id",
  to: "deployment_failed" as const,
  idempotentReplay: false,
};
function database(rows: unknown[] = []) {
  const where = vi.fn(async () => rows);
  const select = vi.fn(() => ({ from: vi.fn(() => ({ where })) }));
  return { db: { select } as never, select, where };
}
describe("Post-commit deployment outcome metrics", () => {
  it("ignores replays and non-final states without querying or counting", async () => {
    const f = database();
    const metrics = new MetricsRegistry();
    await recordDeploymentOutcome(f.db, metrics, { ...transition, idempotentReplay: true });
    await recordDeploymentOutcome(f.db, metrics, { ...transition, to: "building" });
    expect(f.select).not.toHaveBeenCalled();
    expect(metrics.renderPrometheus()).toBe("");
  });
  it("records bounded outcome labels and database-derived elapsed time", async () => {
    const f = database([
      {
        createdAt: new Date(1000),
        finishedAt: new Date(6000),
        updatedAt: new Date(6000),
        healthCheckedAt: null,
      },
    ]);
    const metrics = new MetricsRegistry();
    await recordDeploymentOutcome(f.db, metrics, transition);
    expect(metrics.renderPrometheus()).toContain(
      'launchrail_deployment_final_outcomes_total{outcome="deployment_failed"} 1',
    );
    expect(metrics.renderPrometheus()).toContain(
      'launchrail_deployment_lifecycle_duration_seconds_sum{outcome="deployment_failed"} 5',
    );
    expect(metrics.renderPrometheus()).not.toContain("CANARY");
  });
  it("retains the committed count if timestamp observation fails, without leaking errors", async () => {
    const f = database();
    f.where.mockRejectedValue(new Error("CANARY_connection_secret"));
    const metrics = new MetricsRegistry();
    await expect(recordDeploymentOutcome(f.db, metrics, transition)).resolves.toBeUndefined();
    expect(metrics.renderPrometheus()).toContain(
      'launchrail_deployment_final_outcomes_total{outcome="deployment_failed"} 1',
    );
    expect(metrics.renderPrometheus()).toContain(
      "launchrail_deployment_metric_recording_failures_total 1",
    );
    expect(metrics.renderPrometheus()).not.toContain("CANARY");
  });
  it("never rejects a committed operation when the instrumentation itself is unavailable", async () => {
    const f = database();
    const metrics = new MetricsRegistry();
    vi.spyOn(metrics, "increment").mockImplementation(() => {
      throw new Error("CANARY_instrumentation_failure");
    });
    await expect(recordDeploymentOutcome(f.db, metrics, transition)).resolves.toBeUndefined();
    expect(f.select).not.toHaveBeenCalled();
  });
});
