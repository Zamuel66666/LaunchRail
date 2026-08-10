import { describe, expect, it } from "vitest";

import {
  createDeploymentClaimJobId,
  createDeploymentClaimTransitionIdempotencyKey,
  createDeploymentJobId,
  createDeploymentSourceFailureIdempotencyKey,
  createDeploymentSourceTransitionIdempotencyKey,
  deploymentClaimJobSchema,
  parseDeploymentClaimJob,
  parseDeploymentJob,
  parseDeploymentPrepareSourceJob,
  type DeploymentClaimJob,
  type DeploymentPrepareSourceJob,
} from "../src/index.js";

const workItemId = "3b953ca5-a02b-446f-ad13-04bf6896e010";

const validJob = {
  contractVersion: 1,
  kind: "deployment.claim",
  workItemId,
} satisfies DeploymentClaimJob;

describe("deployment claim job contract", () => {
  it("parses the versioned identifier-only payload", () => {
    expect(parseDeploymentClaimJob(validJob)).toEqual(validJob);
    expect(deploymentClaimJobSchema.parse(validJob)).toEqual(validJob);
  });

  it("rejects unknown fields instead of stripping them", () => {
    expect(() =>
      parseDeploymentClaimJob({
        ...validJob,
        repositoryUrl: "https://github.com/example/private-repository",
      }),
    ).toThrow();
  });

  it("does not accept authoritative deployment data, repository metadata, or secret values", () => {
    expect(() =>
      parseDeploymentClaimJob({
        ...validJob,
        correlationId: "fd95a7b9-b4e8-4ec2-8c84-5a13255e77f6",
        deploymentId: "bc6b6f50-c2bd-48f7-b39a-7e5f5cc91300",
        environment: { DATABASE_PASSWORD: "canary-secret" },
        organizationId: "e2ac9f41-39b9-4aa8-943a-079d7624b7dd",
        repository: { branch: "main", owner: "example", repository: "service" },
      }),
    ).toThrow();
  });

  it.each([
    ["contract version", { ...validJob, contractVersion: 2 }],
    ["job kind", { ...validJob, kind: "deployment.build" }],
    ["work-item ID", { ...validJob, workItemId: "not-a-uuid" }],
  ])("rejects an invalid %s", (_description, value) => {
    expect(() => parseDeploymentClaimJob(value)).toThrow();
  });

  it("derives stable BullMQ and transition identifiers without colons", () => {
    const jobId = createDeploymentClaimJobId(workItemId);
    const transitionKey = createDeploymentClaimTransitionIdempotencyKey(workItemId);

    expect(jobId).toBe(`deployment-claim-v1-${workItemId}`);
    expect(transitionKey).toBe(`worker-claim-v1-${workItemId}`);
    expect(createDeploymentClaimJobId(workItemId)).toBe(jobId);
    expect(createDeploymentClaimTransitionIdempotencyKey(workItemId)).toBe(transitionKey);
    expect(jobId).not.toContain(":");
    expect(transitionKey).not.toContain(":");
  });

  it("canonicalizes UUID case before deriving durable identifiers", () => {
    const uppercaseWorkItemId = workItemId.toUpperCase();

    expect(parseDeploymentClaimJob({ ...validJob, workItemId: uppercaseWorkItemId })).toEqual(
      validJob,
    );
    expect(createDeploymentClaimJobId(uppercaseWorkItemId)).toBe(
      createDeploymentClaimJobId(workItemId),
    );
    expect(createDeploymentClaimTransitionIdempotencyKey(uppercaseWorkItemId)).toBe(
      createDeploymentClaimTransitionIdempotencyKey(workItemId),
    );
  });

  it("rejects unsafe deployment identifiers before deriving keys", () => {
    expect(() => createDeploymentClaimJobId("unsafe:deployment")).toThrow();
    expect(() => createDeploymentClaimTransitionIdempotencyKey("unsafe:deployment")).toThrow();
  });
});

describe("deployment source-preparation job contract", () => {
  const sourceJob = {
    contractVersion: 1,
    kind: "deployment.prepare_source",
    workItemId,
  } satisfies DeploymentPrepareSourceJob;

  it("accepts only the versioned identifier-only source wake-up", () => {
    expect(parseDeploymentJob(sourceJob)).toEqual(sourceJob);
    expect(parseDeploymentPrepareSourceJob(sourceJob)).toEqual(sourceJob);
    expect(() => parseDeploymentJob({ ...sourceJob, revision: "a".repeat(40) })).toThrow();
    expect(() => parseDeploymentPrepareSourceJob(validJob)).toThrow();
  });

  it("derives kind-separated stable queue and transition identifiers", () => {
    expect(createDeploymentJobId(sourceJob)).toBe(`deployment-prepare-source-v1-${workItemId}`);
    expect(createDeploymentJobId(sourceJob)).not.toBe(createDeploymentJobId(validJob));
    expect(createDeploymentSourceTransitionIdempotencyKey(workItemId)).toBe(
      `worker-source-ready-v1-${workItemId}`,
    );
    expect(createDeploymentSourceFailureIdempotencyKey(workItemId)).toBe(
      `worker-source-failure-v1-${workItemId}`,
    );
  });
});
