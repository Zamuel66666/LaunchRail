import type { DeploymentTransitionResult } from "@launchrail/application";
import type { MetricsRegistry } from "@launchrail/observability";
import { and, eq } from "drizzle-orm";
import type { LaunchRailDatabase } from "./client.js";
import { deployments } from "./schema.js";

/** Invoke only after a successful commit, never inside the state-changing transaction. */
export async function recordDeploymentOutcome(
  db: LaunchRailDatabase,
  metrics: MetricsRegistry | undefined,
  transition: Pick<DeploymentTransitionResult, "deploymentId" | "to" | "idempotentReplay">,
  organizationId?: string,
): Promise<void> {
  if (
    !metrics ||
    transition.idempotentReplay ||
    ![
      "active",
      "build_failed",
      "cancelled",
      "deployment_failed",
      "rolled_back",
      "stopped",
    ].includes(transition.to)
  )
    return;
  const outcome = transition.to;
  try {
    metrics.increment("launchrail_deployment_final_outcomes_total", { outcome });
    const [deployment] = await db
      .select({
        createdAt: deployments.createdAt,
        finishedAt: deployments.finishedAt,
        healthCheckedAt: deployments.healthCheckedAt,
        updatedAt: deployments.updatedAt,
      })
      .from(deployments)
      .where(
        and(
          eq(deployments.id, transition.deploymentId),
          ...(organizationId === undefined ? [] : [eq(deployments.organizationId, organizationId)]),
        ),
      );
    if (!deployment) return;
    const completedAt =
      outcome === "active"
        ? (deployment.healthCheckedAt ?? deployment.updatedAt)
        : (deployment.finishedAt ?? deployment.updatedAt);
    metrics.observe(
      "launchrail_deployment_lifecycle_duration_seconds",
      Math.max(0, completedAt.getTime() - deployment.createdAt.getTime()) / 1000,
      { outcome },
      [1, 5, 15, 30, 60, 120, 300, 600, 1200, 3600],
    );
  } catch {
    try {
      metrics.increment("launchrail_deployment_metric_recording_failures_total");
    } catch {
      /* Instrumentation cannot change a committed deployment outcome. */
    }
  }
}
