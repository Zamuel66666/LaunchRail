import { describe, expect, it, vi } from "vitest";

import { TransitionDeployment, type DeploymentTransitionStore } from "../src/index.js";

describe("TransitionDeployment", () => {
  it("delegates the command to the persistence port", async () => {
    const result = {
      deploymentId: "deployment-1",
      eventSequence: 2,
      from: "queued" as const,
      idempotentReplay: false,
      to: "cloning" as const,
      version: 2,
    };
    const transition = vi.fn().mockResolvedValue(result);
    const store = {
      promote: vi.fn(),
      transition,
    } satisfies DeploymentTransitionStore;
    const useCase = new TransitionDeployment(store);
    const command = {
      deploymentId: "deployment-1",
      idempotencyKey: "claim-1",
      organizationId: "organization-1",
      to: "cloning" as const,
    };

    await expect(useCase.execute(command)).resolves.toEqual(result);
    expect(transition).toHaveBeenCalledWith(command);
  });
});
