import { describe, expect, it } from "vitest";

import { computeDeploymentJobBackoffMs } from "../src/index.js";

const workItemOne = "11111111-1111-4111-8111-111111111111";
const workItemTwo = "22222222-2222-4222-8222-222222222222";

describe("computeDeploymentJobBackoffMs", () => {
  it("returns the same delay for the same work item and attempt", () => {
    const options = {
      attempt: 3,
      baseDelayMs: 1_000,
      maxDelayMs: 60_000,
      workItemId: workItemOne,
    } as const;

    expect(computeDeploymentJobBackoffMs(options)).toBe(computeDeploymentJobBackoffMs(options));
  });

  it("grows exponentially before reaching the cap", () => {
    const delays = [1, 2, 3, 4].map((attempt) =>
      computeDeploymentJobBackoffMs({
        attempt,
        baseDelayMs: 1_000,
        maxDelayMs: 60_000,
        workItemId: workItemOne,
      }),
    );

    expect(delays[1]).toBeGreaterThan(delays[0] as number);
    expect(delays[2]).toBeGreaterThan(delays[1] as number);
    expect(delays[3]).toBeGreaterThan(delays[2] as number);
  });

  it("never exceeds the configured cap", () => {
    for (const attempt of [8, 16, 64, 1_000]) {
      expect(
        computeDeploymentJobBackoffMs({
          attempt,
          baseDelayMs: 1_000,
          maxDelayMs: 5_000,
          workItemId: workItemOne,
        }),
      ).toBeLessThanOrEqual(5_000);
    }
  });

  it("uses the work item and attempt as the jitter seed", () => {
    const first = computeDeploymentJobBackoffMs({
      attempt: 5,
      baseDelayMs: 10_000,
      maxDelayMs: 1_000_000,
      workItemId: workItemOne,
    });
    const second = computeDeploymentJobBackoffMs({
      attempt: 5,
      baseDelayMs: 10_000,
      maxDelayMs: 1_000_000,
      workItemId: workItemTwo,
    });
    const nextAttempt = computeDeploymentJobBackoffMs({
      attempt: 6,
      baseDelayMs: 10_000,
      maxDelayMs: 1_000_000,
      workItemId: workItemOne,
    });

    expect(first).not.toBe(second);
    expect(first).not.toBe(nextAttempt);
  });

  it.each([
    ["attempt", { attempt: 0, baseDelayMs: 1, maxDelayMs: 1, workItemId: workItemOne }],
    ["base delay", { attempt: 1, baseDelayMs: -1, maxDelayMs: 1, workItemId: workItemOne }],
    ["maximum delay", { attempt: 1, baseDelayMs: 1, maxDelayMs: 0, workItemId: workItemOne }],
    ["delay order", { attempt: 1, baseDelayMs: 2, maxDelayMs: 1, workItemId: workItemOne }],
    ["work item", { attempt: 1, baseDelayMs: 1, maxDelayMs: 1, workItemId: "not-a-uuid" }],
  ])("rejects invalid %s input", (_description, options) => {
    expect(() => computeDeploymentJobBackoffMs(options)).toThrow();
  });
});
