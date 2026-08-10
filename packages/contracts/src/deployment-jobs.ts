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

export const deploymentJobSchema = z.discriminatedUnion("kind", [
  deploymentClaimJobSchema,
  deploymentPrepareSourceJobSchema,
]);

export type DeploymentClaimJob = z.infer<typeof deploymentClaimJobSchema>;
export type DeploymentPrepareSourceJob = z.infer<typeof deploymentPrepareSourceJobSchema>;
export type DeploymentJob = z.infer<typeof deploymentJobSchema>;

export function parseDeploymentClaimJob(input: unknown): DeploymentClaimJob {
  return deploymentClaimJobSchema.parse(input);
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
  return job.kind === "deployment.claim"
    ? createDeploymentClaimJobId(job.workItemId)
    : `deployment-prepare-source-v1-${parseWorkItemId(job.workItemId)}`;
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
