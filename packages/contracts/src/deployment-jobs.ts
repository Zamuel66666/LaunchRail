import { z } from "zod";

const workItemIdSchema = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());

export const deploymentClaimJobSchema = z
  .object({
    contractVersion: z.literal(1),
    kind: z.literal("deployment.claim"),
    workItemId: workItemIdSchema,
  })
  .strict();

export const deploymentPrepareSourceJobSchema = z
  .object({
    contractVersion: z.literal(1),
    kind: z.literal("deployment.prepare_source"),
    workItemId: workItemIdSchema,
  })
  .strict();

export const deploymentBuildJobSchema = z
  .object({
    contractVersion: z.literal(1),
    kind: z.literal("deployment.build"),
    workItemId: workItemIdSchema,
  })
  .strict();

export const deploymentStartRuntimeJobSchema = z
  .object({
    contractVersion: z.literal(1),
    kind: z.literal("deployment.start_runtime"),
    workItemId: workItemIdSchema,
  })
  .strict();

export const deploymentJobSchema = z.discriminatedUnion("kind", [
  deploymentClaimJobSchema,
  deploymentPrepareSourceJobSchema,
  deploymentBuildJobSchema,
  deploymentStartRuntimeJobSchema,
]);

export type DeploymentBuildJob = z.infer<typeof deploymentBuildJobSchema>;
export type DeploymentStartRuntimeJob = z.infer<typeof deploymentStartRuntimeJobSchema>;
export type DeploymentClaimJob = z.infer<typeof deploymentClaimJobSchema>;
export type DeploymentPrepareSourceJob = z.infer<typeof deploymentPrepareSourceJobSchema>;
export type DeploymentJob = z.infer<typeof deploymentJobSchema>;

export function parseDeploymentClaimJob(input: unknown): DeploymentClaimJob {
  return deploymentClaimJobSchema.parse(input);
}

export function parseDeploymentBuildJob(input: unknown): DeploymentBuildJob {
  return deploymentBuildJobSchema.parse(input);
}

export function parseDeploymentStartRuntimeJob(input: unknown): DeploymentStartRuntimeJob {
  return deploymentStartRuntimeJobSchema.parse(input);
}

export function parseDeploymentJob(input: unknown): DeploymentJob {
  return deploymentJobSchema.parse(input);
}

export function parseDeploymentPrepareSourceJob(input: unknown): DeploymentPrepareSourceJob {
  return deploymentPrepareSourceJobSchema.parse(input);
}

function parseWorkItemId(workItemId: string): string {
  return z
    .string()
    .uuid()
    .transform((value) => value.toLowerCase())
    .parse(workItemId);
}

export function createDeploymentClaimJobId(workItemId: string): string {
  return `deployment-claim-v1-${parseWorkItemId(workItemId)}`;
}

export function createDeploymentJobId(job: Pick<DeploymentJob, "kind" | "workItemId">): string {
  const workItemId = parseWorkItemId(job.workItemId);
  switch (job.kind) {
    case "deployment.build":
      return `deployment-build-v1-${workItemId}`;
    case "deployment.start_runtime":
      return `deployment-start-runtime-v1-${workItemId}`;
    case "deployment.claim":
      return `deployment-claim-v1-${workItemId}`;
    case "deployment.prepare_source":
      return `deployment-prepare-source-v1-${workItemId}`;
  }
}

export function createDeploymentClaimTransitionIdempotencyKey(workItemId: string): string {
  return `worker-claim-v1-${parseWorkItemId(workItemId)}`;
}

export function createDeploymentSourceFailureIdempotencyKey(workItemId: string): string {
  return `worker-source-failure-v1-${parseWorkItemId(workItemId)}`;
}

export function createDeploymentSourceTransitionIdempotencyKey(workItemId: string): string {
  return `worker-source-ready-v1-${parseWorkItemId(workItemId)}`;
}

export function createDeploymentBuildFailureIdempotencyKey(workItemId: string): string {
  return `worker-build-failure-v1-${parseWorkItemId(workItemId)}`;
}

export function createDeploymentBuildTransitionIdempotencyKey(workItemId: string): string {
  return `worker-build-ready-v1-${parseWorkItemId(workItemId)}`;
}

export function createDeploymentRuntimeFailureIdempotencyKey(workItemId: string): string {
  return `worker-runtime-failure-v1-${parseWorkItemId(workItemId)}`;
}

export function createDeploymentRuntimeTransitionIdempotencyKey(workItemId: string): string {
  return `worker-runtime-ready-v1-${parseWorkItemId(workItemId)}`;
}
