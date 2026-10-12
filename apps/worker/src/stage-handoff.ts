import { parseDeploymentJob, type DeploymentJob } from "@launchrail/contracts";
import type { DispatchableDeploymentJob } from "@launchrail/application";
import type { MetricsRegistry, TraceHeaders } from "@launchrail/observability";
import type { DeploymentJobHandler } from "@launchrail/queue";
import type { DeploymentJobProcessingOutcome, WorkerEventLogger } from "./processor.js";

export function createStageHandoffHandler(options: {
  readonly processor: {
    process(job: DeploymentJob, signal: AbortSignal): Promise<DeploymentJobProcessingOutcome>;
  };
  readonly store: {
    listFollowupDispatchable(workItemId: string): Promise<readonly DispatchableDeploymentJob[]>;
  };
  readonly publisher: {
    enqueue(job: DeploymentJob, traceHeaders?: TraceHeaders): Promise<unknown>;
  };
  readonly logger: Pick<WorkerEventLogger, "warn">;
  readonly metrics?: MetricsRegistry;
}): DeploymentJobHandler {
  const observe = (kind: string, outcome: "published" | "deferred") => {
    try {
      options.metrics?.increment("launchrail_worker_stage_handoffs_total", { kind, outcome });
    } catch {
      /* Telemetry cannot change already committed work. */
    }
  };
  return async (job, signal) => {
    const outcome = await options.processor.process(job, signal);
    if (outcome !== "completed" || signal.aborted || job.kind === "deployment.start_runtime")
      return;
    try {
      // Only committed, eligible next-stage records are authority for a wake-up.
      const followups = await options.store.listFollowupDispatchable(job.workItemId);
      for (const next of followups) {
        if (signal.aborted) return;
        const payload = parseDeploymentJob({
          contractVersion: next.contractVersion,
          kind: next.kind,
          workItemId: next.id,
        });
        if (next.traceParent === undefined) await options.publisher.enqueue(payload);
        else await options.publisher.enqueue(payload, { traceparent: next.traceParent });
        observe(job.kind, "published");
      }
    } catch {
      observe(job.kind, "deferred");
      try {
        options.logger.warn(
          { event: "deployment_stage_wakeup_deferred", workItemId: job.workItemId },
          "Next deployment stage will be recovered by reconciliation",
        );
      } catch {
        /* Failed diagnostics must not fail a committed queue handler. */
      }
    }
  };
}
