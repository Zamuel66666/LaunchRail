import { describe, expect, it } from "vitest";

import {
  InvalidDeploymentTransitionError,
  assertDeploymentTransition,
  canTransitionDeployment,
  deploymentStates,
  isTerminalDeploymentState,
} from "../src/index.js";

const validTransitions = [
  ["queued", "cloning"],
  ["queued", "cancelling"],
  ["cloning", "building"],
  ["cloning", "build_failed"],
  ["cloning", "cancelling"],
  ["building", "deploying"],
  ["building", "build_failed"],
  ["building", "cancelling"],
  ["deploying", "health_checking"],
  ["deploying", "deployment_failed"],
  ["deploying", "cancelling"],
  ["health_checking", "active"],
  ["health_checking", "deployment_failed"],
  ["health_checking", "cancelling"],
  ["cancelling", "cancelled"],
  ["active", "superseded"],
  ["active", "rolling_back"],
  ["rolling_back", "rolled_back"],
  ["rolling_back", "active"],
  ["superseded", "active"],
  ["active", "stopped"],
  ["superseded", "stopped"],
] as const;

describe("deployment state machine", () => {
  it.each(validTransitions)("accepts %s -> %s", (from, to) => {
    expect(canTransitionDeployment(from, to)).toBe(true);
    expect(() => assertDeploymentTransition(from, to)).not.toThrow();
  });

  it("rejects every transition not listed in the lifecycle", () => {
    const validPairs = new Set(validTransitions.map(([from, to]) => `${from}:${to}`));

    for (const from of deploymentStates) {
      for (const to of deploymentStates) {
        if (validPairs.has(`${from}:${to}`)) {
          continue;
        }

        expect(canTransitionDeployment(from, to), `${from} -> ${to}`).toBe(false);
        expect(() => assertDeploymentTransition(from, to)).toThrow(
          InvalidDeploymentTransitionError,
        );
      }
    }
  });

  it("identifies terminal states without treating superseded as terminal", () => {
    expect(deploymentStates.filter((state) => isTerminalDeploymentState(state))).toEqual([
      "build_failed",
      "deployment_failed",
      "stopped",
      "cancelled",
      "rolled_back",
    ]);
  });
});
