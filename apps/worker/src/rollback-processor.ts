import { setTimeout as delay } from "node:timers/promises";
import type {
  DeploymentRollbackStore,
  DeploymentRuntimeManager,
  StartedDeploymentRuntimeMetadata,
} from "@launchrail/application";
import type { HttpHealthCheckCommand, HttpHealthCheckResult } from "@launchrail/runtime";
import { HttpHealthCheckError } from "@launchrail/runtime";
import type { WorkerEventLogger } from "./processor.js";

export interface DeploymentRollbackProcessorOptions {
  readonly store: DeploymentRollbackStore;
  readonly runtimeManager: DeploymentRuntimeManager;
  readonly healthCheck: (command: HttpHealthCheckCommand) => Promise<HttpHealthCheckResult>;
  readonly workerId: string;
  readonly leaseDurationMs: number;
  readonly heartbeatIntervalMs: number;
  readonly jobTimeoutMs: number;
  readonly healthGraceMs: number;
  readonly logger: WorkerEventLogger;
}

export class DeploymentRollbackProcessor {
  private inFlight: Promise<void> | undefined;
  public constructor(private readonly options: DeploymentRollbackProcessorOptions) {}
  public getActiveJobCount() {
    return this.inFlight === undefined ? 0 : 1;
  }
  public async waitForIdle() {
    await this.inFlight;
  }
  public runOnce(): Promise<void> {
    this.inFlight ??= this.process().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }
  private async process() {
    const lease = await this.options.store.claim({
      workerId: this.options.workerId,
      leaseDurationMs: this.options.leaseDurationMs,
    });
    if (!lease) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(this.options.jobTimeoutMs),
    ]);
    let heartbeats = Promise.resolve();
    const timer = setInterval(() => {
      heartbeats = heartbeats
        .then(async () => {
          if (
            !(await this.options.store.heartbeat({
              id: lease.id,
              leaseToken: lease.leaseToken,
              leaseDurationMs: this.options.leaseDurationMs,
            }))
          )
            controller.abort(new Error("Rollback lease lost"));
        })
        .catch(() => {
          controller.abort(new Error("Rollback heartbeat unavailable"));
        });
    }, this.options.heartbeatIntervalMs);
    let runtime: StartedDeploymentRuntimeMetadata | undefined;
    let healthFailure:
      { statusCode: number | null; durationMs: number; checkedAt: Date } | undefined;
    let errorCode: "rollback_unhealthy" | "rollback_infrastructure_unavailable" =
      "rollback_infrastructure_unavailable";
    try {
      const started = await this.options.runtimeManager.start({
        identity: {
          deploymentId: lease.runtime.deploymentId,
          organizationId: lease.runtime.organizationId,
          projectId: lease.runtime.projectId,
          workItemId: lease.runtime.workItemId,
        },
        image: lease.runtime,
        healthCheckPort: lease.runtime.healthCheckPort,
        runtimeConfig: lease.runtime.runtimeConfig,
        signal,
      });
      runtime = { ...started, imageDigest: lease.runtime.manifestDigest };
      await delay(this.options.healthGraceMs, undefined, { signal });
      errorCode = "rollback_unhealthy";
      const health = await this.options.healthCheck({
        host: "127.0.0.1",
        port: started.hostPort,
        path: lease.runtime.healthCheckPath,
        timeoutMs: Math.min(5000, this.options.jobTimeoutMs),
      });
      signal.throwIfAborted();
      if (health.statusCode < 200 || health.statusCode >= 300) {
        healthFailure = {
          statusCode: health.statusCode,
          durationMs: Math.round(health.durationMs),
          checkedAt: new Date(),
        };
        throw new Error("Rollback health rejected");
      }
      errorCode = "rollback_infrastructure_unavailable";
      const recorded = await this.options.store.finish({
        id: lease.id,
        leaseToken: lease.leaseToken,
        result: {
          runtime,
          healthCheckedAt: new Date(),
          healthDurationMs: Math.round(health.durationMs),
          healthStatusCode: health.statusCode,
        },
      });
      if (!recorded)
        this.options.logger.warn(
          { event: "rollback_completion_fenced", rollbackId: lease.id },
          "Rollback completion did not own a live lease",
        );
    } catch (error) {
      if (error instanceof HttpHealthCheckError)
        healthFailure = {
          statusCode: null,
          durationMs: Math.min(30000, Math.round(error.durationMs)),
          checkedAt: new Date(),
        };
      // A replacement lease owns any late-started container. Never stop it here.
      await this.options.store.finish({
        id: lease.id,
        leaseToken: lease.leaseToken,
        result: {
          errorCode,
          ...(runtime === undefined ? {} : { runtime }),
          ...(healthFailure === undefined ? {} : { healthFailure }),
        },
      });
      this.options.logger.warn(
        { event: "rollback_preparation_failed", rollbackId: lease.id, errorCode },
        "Rollback preparation failed; the current release is retained",
      );
    } finally {
      clearInterval(timer);
      await heartbeats;
    }
  }
}
