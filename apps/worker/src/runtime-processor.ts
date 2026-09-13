import type {
  DeploymentJobLease,
  DeploymentJobStore,
  DeploymentRuntimeFailureCategory,
  DeploymentRuntimeManager,
  DeploymentTransitionStore,
  FailDeploymentRuntimeCommand,
} from "@launchrail/application";
import { RuntimeStartError } from "@launchrail/application";
import type { DeploymentStartRuntimeJob } from "@launchrail/contracts";
import { computeDeploymentJobBackoffMs } from "@launchrail/queue";
import type { HttpHealthCheckResult } from "@launchrail/runtime";
import type { RouteManager } from "@launchrail/routing";

import type { DeploymentJobProcessingOutcome, WorkerEventLogger } from "./processor.js";

export interface DeploymentRuntimeProcessorOptions {
  readonly backoffBaseMs: number;
  readonly backoffCapMs: number;
  readonly heartbeatIntervalMs: number;
  readonly jobTimeoutMs: number;
  readonly leaseDurationMs: number;
  readonly logger: WorkerEventLogger;
  readonly runtimeManager: DeploymentRuntimeManager;
  readonly store: DeploymentJobStore;
  readonly transitionStore?: DeploymentTransitionStore;
  readonly workerId: string;
  readonly healthCheck?: (command: {
    readonly host: string;
    readonly path: string;
    readonly port: number;
    readonly timeoutMs: number;
  }) => Promise<HttpHealthCheckResult>;
  readonly healthGraceMs?: number;
  readonly routeManager?: RouteManager;
}

interface SafeRuntimeFailure {
  readonly category: DeploymentRuntimeFailureCategory;
  readonly message: string;
  readonly retryable: boolean;
}

function safeFailure(error: unknown): SafeRuntimeFailure {
  if (!(error instanceof RuntimeStartError)) {
    return {
      category: "infrastructure_unavailable",
      message: "The runtime manager is temporarily unavailable",
      retryable: true,
    };
  }
  switch (error.code) {
    case "runtime_policy_rejected":
    case "runtime_metadata_invalid":
      return {
        category: "runtime_policy_rejected",
        message: "The runtime did not satisfy the configured isolation policy",
        retryable: false,
      };
    case "runtime_timeout":
      return {
        category: "runtime_timeout",
        message: "The runtime operation exceeded its time limit",
        retryable: false,
      };
    case "runtime_start_failed":
      return {
        category: "runtime_start_failed",
        message: "The deployment runtime could not be started",
        retryable: true,
      };
    case "runtime_cleanup_failed":
    case "runtime_unavailable":
      return {
        category: "infrastructure_unavailable",
        message: "The runtime manager is temporarily unavailable",
        retryable: true,
      };
  }
}

export class DeploymentRuntimeProcessor {
  private activeJobCount = 0;
  private readonly waiters = new Set<() => void>();
  public constructor(private readonly options: DeploymentRuntimeProcessorOptions) {}

  public getActiveJobCount(): number {
    return this.activeJobCount;
  }
  public waitForIdle(): Promise<void> {
    return this.activeJobCount === 0
      ? Promise.resolve()
      : new Promise((resolve) => this.waiters.add(resolve));
  }
  private finish(): void {
    this.activeJobCount -= 1;
    if (this.activeJobCount === 0) {
      for (const resolve of this.waiters) resolve();
      this.waiters.clear();
    }
  }
  private startHeartbeat(lease: DeploymentJobLease, controller: AbortController): () => void {
    const timer = setInterval(() => {
      void this.options.store
        .heartbeat({
          leaseDurationMs: this.options.leaseDurationMs,
          leaseToken: lease.leaseToken,
          workItemId: lease.workItemId,
        })
        .then((result) => {
          if (result.kind !== "extended") controller.abort(new Error("Runtime job lease was lost"));
        })
        .catch(() => controller.abort(new Error("Runtime job heartbeat failed")));
    }, this.options.heartbeatIntervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  public async process(
    job: DeploymentStartRuntimeJob,
    shutdownSignal: AbortSignal,
  ): Promise<DeploymentJobProcessingOutcome> {
    if (shutdownSignal.aborted) return "interrupted";
    const claim = await this.options.store
      .claim({
        expectedKind: job.kind,
        leaseDurationMs: this.options.leaseDurationMs,
        workerId: this.options.workerId,
        workItemId: job.workItemId,
      })
      .catch(() => undefined);
    if (claim === undefined)
      return shutdownSignal.aborted ? "interrupted" : "infrastructure_unavailable";
    if (claim.kind === "completed" || claim.kind === "dead_lettered") return "terminal";
    if (claim.kind !== "claimed") return "lease_unavailable";
    const lease = claim.lease;
    const timeout = AbortSignal.timeout(this.options.jobTimeoutMs);
    const leaseLost = new AbortController();
    const signal = AbortSignal.any([shutdownSignal, timeout, leaseLost.signal]);
    const stopHeartbeat = this.startHeartbeat(lease, leaseLost);
    this.activeJobCount += 1;
    try {
      const loaded = await this.options.store.loadRuntimeInput({
        leaseToken: lease.leaseToken,
        workItemId: lease.workItemId,
      });
      if (loaded.kind === "build_not_ready")
        return await this.persistFailure(
          lease,
          {
            category: "internal_invariant_violation",
            message: "The deployment image is not ready to run",
            retryable: false,
          },
          signal,
        );
      if (loaded.kind !== "loaded") return "interrupted";
      let started;
      try {
        started = await this.options.runtimeManager.start({
          healthCheckPort: loaded.runtime.healthCheckPort,
          identity: {
            deploymentId: loaded.runtime.deploymentId,
            organizationId: loaded.runtime.organizationId,
            projectId: loaded.runtime.projectId,
            workItemId: loaded.runtime.workItemId,
          },
          image: {
            imageId: loaded.runtime.imageId,
            imageReference: loaded.runtime.imageReference,
            manifestDigest: loaded.runtime.manifestDigest,
            platform: loaded.runtime.platform,
          },
          runtimeConfig: loaded.runtime.runtimeConfig,
          signal,
        });
      } catch (error) {
        if (signal.aborted) return "interrupted";
        return await this.persistFailure(lease, safeFailure(error), signal);
      }
      try {
        if (this.options.healthCheck === undefined)
          return await this.completeRuntime(lease, loaded, started);
        const healthGraceMs = this.options.healthGraceMs ?? 0;
        if (healthGraceMs > 0)
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, healthGraceMs);
            const abort = (): void => {
              clearTimeout(timer);
              reject(signal.reason ?? new Error("Health grace period interrupted"));
            };
            if (signal.aborted) abort();
            else signal.addEventListener("abort", abort, { once: true });
          });
        const health = await this.options.healthCheck({
          host: "127.0.0.1",
          path: loaded.runtime.healthCheckPath,
          port: started.hostPort,
          timeoutMs: Math.min(this.options.jobTimeoutMs, 5_000),
        });
        await this.options.store.recordHealthCheck?.({
          checkedAt: new Date(),
          deploymentId: loaded.runtime.deploymentId,
          durationMs: health.durationMs,
          organizationId: loaded.runtime.organizationId,
          outcome: health.statusCode >= 200 && health.statusCode < 400 ? "passed" : "failed",
          statusCode: health.statusCode,
        });
        if (health.statusCode < 200 || health.statusCode >= 400)
          throw new Error(`Health check returned HTTP ${health.statusCode}`);
      } catch (error) {
        await this.options.runtimeManager
          .stop({
            containerId: started.containerId,
            identity: {
              deploymentId: loaded.runtime.deploymentId,
              organizationId: loaded.runtime.organizationId,
              projectId: loaded.runtime.projectId,
              workItemId: loaded.runtime.workItemId,
            },
            signal,
          })
          .catch(() => undefined);
        if (signal.aborted) return "interrupted";
        return await this.persistFailure(
          lease,
          {
            category: "runtime_start_failed",
            message: error instanceof Error ? error.message : "Runtime health check failed",
            retryable: true,
          },
          signal,
        );
      }
      if (this.options.routeManager !== undefined) {
        try {
          await this.options.routeManager.apply(
            {
              deploymentId: loaded.runtime.deploymentId,
              hostname: `d-${loaded.runtime.deploymentId}.localhost`,
            },
            { hostPort: started.hostPort },
          );
        } catch (error) {
          await this.options.runtimeManager
            .stop({
              containerId: started.containerId,
              identity: {
                deploymentId: loaded.runtime.deploymentId,
                organizationId: loaded.runtime.organizationId,
                projectId: loaded.runtime.projectId,
                workItemId: loaded.runtime.workItemId,
              },
              signal,
            })
            .catch(() => undefined);
          return await this.persistFailure(
            lease,
            {
              category: "infrastructure_unavailable",
              message:
                error instanceof Error ? error.message : "Preview route could not be registered",
              retryable: true,
            },
            signal,
          );
        }
      }
      return await this.completeRuntime(lease, loaded, started, new Date());
    } catch (error) {
      if (signal.aborted) return "interrupted";
      return await this.persistFailure(lease, safeFailure(error), signal);
    } finally {
      stopHeartbeat();
      this.finish();
    }
  }

  private async completeRuntime(
    lease: DeploymentJobLease,
    loaded: Extract<
      Awaited<ReturnType<DeploymentJobStore["loadRuntimeInput"]>>,
      { kind: "loaded" }
    >,
    started: {
      containerId: string;
      hostPort: number;
      resourceMetadata: Readonly<Record<string, unknown>>;
    },
    healthCheckedAt?: Date,
  ): Promise<DeploymentJobProcessingOutcome> {
    const completion = await this.options.store.completeRuntime({
      leaseToken: lease.leaseToken,
      runtime: { ...started, imageDigest: loaded.runtime.manifestDigest },
      workItemId: lease.workItemId,
      ...(healthCheckedAt === undefined ? {} : { healthCheckedAt }),
    });
    if (completion.kind !== "completed") return "interrupted";
    if (healthCheckedAt !== undefined && this.options.transitionStore !== undefined) {
      await this.options.transitionStore.promote({
        deploymentId: loaded.runtime.deploymentId,
        idempotencyKey: `worker-health-promote-${loaded.runtime.deploymentId}`,
        organizationId: loaded.runtime.organizationId,
      });
    }
    this.options.logger.info(
      {
        containerId: started.containerId,
        event: "deployment_runtime_started",
        hostPort: started.hostPort,
        workItemId: lease.workItemId,
      },
      "Deployment runtime started and recorded",
    );
    return "completed";
  }

  private async persistFailure(
    lease: DeploymentJobLease,
    failure: SafeRuntimeFailure,
    signal: AbortSignal,
  ): Promise<DeploymentJobProcessingOutcome> {
    if (signal.aborted) return "interrupted";
    const command: FailDeploymentRuntimeCommand = {
      failure: { category: failure.category, message: failure.message },
      leaseToken: lease.leaseToken,
      retryable: failure.retryable,
      retryDelayMs: computeDeploymentJobBackoffMs({
        attempt: lease.attemptCount,
        baseDelayMs: this.options.backoffBaseMs,
        maxDelayMs: this.options.backoffCapMs,
        workItemId: lease.workItemId,
      }),
      workItemId: lease.workItemId,
    };
    const result = await this.options.store.failRuntime(command).catch(() => undefined);
    if (result?.kind === "retry_scheduled") return "retry_scheduled";
    if (result?.kind === "dead_lettered") return "dead_lettered";
    return "interrupted";
  }
}
