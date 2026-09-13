import { describe, expect, it, vi } from "vitest";

import { createGitHubWebhookDeploymentTrigger } from "../src/webhook-trigger.js";

const organizationId = "11111111-1111-4111-8111-111111111111";
const deploymentId = "22222222-2222-4222-8222-222222222222";
const workItemId = "33333333-3333-4333-8333-333333333333";

describe("GitHub webhook deployment trigger", () => {
  it("creates a matching snapshot and immediately publishes its durable claim wake-up", async () => {
    const createDeployment = vi.fn().mockResolvedValue({ deploymentId });
    const ensurePendingClaim = vi.fn().mockResolvedValue({
      job: { id: workItemId },
      kind: "created",
    });
    const enqueue = vi.fn().mockResolvedValue({ jobId: `deployment-claim-v1-${workItemId}` });
    const trigger = createGitHubWebhookDeploymentTrigger({
      deploymentCreationStore: { createDeployment },
      deploymentJobStore: { ensurePendingClaim },
      maxAttempts: 5,
      onDispatchFailure: vi.fn(),
      projectStore: {
        listProjects: vi.fn().mockResolvedValue([
          {
            defaultBranch: "main",
            id: "44444444-4444-4444-8444-444444444444",
            repositoryUrl: "https://github.com/octo/app",
          },
        ]),
      },
      publisher: { enqueue },
    });

    await trigger.trigger({
      deliveryId: "github-delivery-1",
      organizationId,
      push: {
        branch: "main",
        repositoryName: "app",
        repositoryOwner: "octo",
        revision: "a".repeat(40),
      },
    });

    expect(createDeployment).toHaveBeenCalledWith({
      organizationId,
      projectId: "44444444-4444-4444-8444-444444444444",
      sourceRevision: "a".repeat(40),
    });
    expect(ensurePendingClaim).toHaveBeenCalledWith(
      expect.objectContaining({ deploymentId, maxAttempts: 5, organizationId }),
    );
    expect(enqueue).toHaveBeenCalledWith({
      contractVersion: 1,
      kind: "deployment.claim",
      workItemId,
    });
  });

  it("keeps the durable deployment for reconciliation when direct publication is unavailable", async () => {
    const onDispatchFailure = vi.fn();
    const trigger = createGitHubWebhookDeploymentTrigger({
      deploymentCreationStore: { createDeployment: vi.fn().mockResolvedValue({ deploymentId }) },
      deploymentJobStore: {
        ensurePendingClaim: vi.fn().mockResolvedValue({ job: { id: workItemId }, kind: "created" }),
      },
      maxAttempts: 5,
      onDispatchFailure,
      projectStore: {
        listProjects: vi.fn().mockResolvedValue([
          {
            defaultBranch: "main",
            id: "44444444-4444-4444-8444-444444444444",
            repositoryUrl: "https://github.com/octo/app",
          },
        ]),
      },
      publisher: { enqueue: vi.fn().mockRejectedValue(new Error("Redis unavailable")) },
    });

    await expect(
      trigger.trigger({
        deliveryId: "github-delivery-2",
        organizationId,
        push: {
          branch: "main",
          repositoryName: "app",
          repositoryOwner: "octo",
          revision: "a".repeat(40),
        },
      }),
    ).resolves.toBeUndefined();
    expect(onDispatchFailure).toHaveBeenCalledWith(expect.objectContaining({ deploymentId }));
  });
});
