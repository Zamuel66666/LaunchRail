import { z } from "zod";

export const deploymentClaimJobSchema = z
  .object({
    contractVersion: z.literal(1),
    kind: z.literal("deployment.claim"),
    workItemId: z
      .string()
      .uuid()
      .transform((value) => value.toLowerCase()),
  })
  .strict();

export type DeploymentClaimJob = z.infer<typeof deploymentClaimJobSchema>;

export function parseDeploymentClaimJob(input: unknown): DeploymentClaimJob {
  return deploymentClaimJobSchema.parse(input);
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

export function createDeploymentClaimTransitionIdempotencyKey(workItemId: string): string {
  return `worker-claim-v1-${parseWorkItemId(workItemId)}`;
}
