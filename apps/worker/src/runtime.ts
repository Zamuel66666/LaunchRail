import type { DeploymentJobStore, WorkerHeartbeatStatus } from "@launchrail/application";

import type { WorkerEventLogger } from "./processor.js";
import type { DeploymentJobReconciler } from "./reconciler.js";

export interface DeploymentQueueConsumerLifecycle {
  cancelActive(): void;
  close(force?: boolean): Promise<void>;
  drain(): Promise<void>;
  pause(): Promise<void>;
  start(): void;
  waitUntilReady(): Promise<void>;
}

export interface DeploymentQueuePublisherLifecycle {
  close(): Promise<void>;
  waitUntilReady(): Promise<void>;
}

export interface DeploymentProcessorLifecycle {
  getActiveJobCount(): number;
  waitForIdle(): Promise<void>;
}

export interface DeploymentWorkerRuntimeOptions {
  readonly consumer: DeploymentQueueConsumerLifecycle;
  readonly heartbeatIntervalMs: number;
  readonly logger: WorkerEventLogger;
  readonly processor: DeploymentProcessorLifecycle;
  readonly publisher: DeploymentQueuePublisherLifecycle;
  readonly reconciliationIntervalMs: number;
  readonly reconciler: DeploymentJobReconciler;
  readonly shutdownGraceMs: number;
  readonly store: DeploymentJobStore;
  readonly version: string;
  readonly workerId: string;
}

type RuntimeState = "created" | "starting" | "ready" | "stopping" | "stopped";

function ignoreFailure(operation: Promise<unknown>): Promise<void> {
  return operation.then(
    () => undefined,
    () => undefined,
  );
}

async function settleBeforeDeadline(
  operation: Promise<unknown>,
  deadline: number,
): Promise<boolean> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    void ignoreFailure(operation);
    return false;
  }

  let timer: NodeJS.Timeout | undefined;
  const deadlineReached = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), remainingMs);
  });
  const settled = ignoreFailure(operation).then(() => true as const);
  const result = await Promise.race([settled, deadlineReached]);
  if (timer !== undefined) {
    clearTimeout(timer);
  }
  return result;
}

export class DeploymentWorkerRuntime {
  private readonly consumer: DeploymentQueueConsumerLifecycle;
  private heartbeatInterval: NodeJS.Timeout | undefined;
  private heartbeatWrites = Promise.resolve();
  private readonly heartbeatIntervalMs: number;
  private readonly logger: WorkerEventLogger;
  private readonly processor: DeploymentProcessorLifecycle;
  private readonly publisher: DeploymentQueuePublisherLifecycle;
  private periodicHeartbeat: Promise<void> | undefined;
  private periodicReconciliation: Promise<unknown> | undefined;
  private reconciliationInterval: NodeJS.Timeout | undefined;
  private readonly reconciliationIntervalMs: number;
  private readonly reconciler: DeploymentJobReconciler;
  private readonly shutdownGraceMs: number;
  private state: RuntimeState = "created";
  private readonly store: DeploymentJobStore;
  private stopPromise: Promise<void> | undefined;
  private readonly version: string;
  private readonly workerId: string;

  public constructor({
    consumer,
    heartbeatIntervalMs,
    logger,
    processor,
    publisher,
    reconciliationIntervalMs,
    reconciler,
    shutdownGraceMs,
    store,
    version,
    workerId,
  }: DeploymentWorkerRuntimeOptions) {
    this.consumer = consumer;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.logger = logger;
    this.processor = processor;
    this.publisher = publisher;
    this.reconciliationIntervalMs = reconciliationIntervalMs;
    this.reconciler = reconciler;
    this.shutdownGraceMs = shutdownGraceMs;
    this.store = store;
    this.version = version;
    this.workerId = workerId;
  }

  public getState(): RuntimeState {
    return this.state;
  }

  private async persistHeartbeat(status: WorkerHeartbeatStatus, required: boolean): Promise<void> {
    try {
      const result = await this.store.recordWorkerHeartbeat({
        activeJobCount: status === "stopped" ? 0 : this.processor.getActiveJobCount(),
        status,
        version: this.version,
        workerId: this.workerId,
      });
      if (result.kind === "invalid_transition" || result.kind === "version_mismatch") {
        throw new Error("Worker heartbeat ownership was rejected");
      }
    } catch (error) {
      this.logger.error(
        { event: "worker_heartbeat_failed", status, workerId: this.workerId },
        "Worker heartbeat could not reach authoritative storage",
      );
      if (required) {
        throw error;
      }
    }
  }

  private queueHeartbeat(status: WorkerHeartbeatStatus, required = false): Promise<void> {
    const write = this.heartbeatWrites.then(() => this.persistHeartbeat(status, required));
    this.heartbeatWrites = write.catch(() => undefined);
    return write;
  }

  private beginIntervals(): void {
    this.heartbeatInterval = setInterval(() => {
      if (this.periodicHeartbeat !== undefined) {
        return;
      }
      const operation = this.queueHeartbeat("ready");
      this.periodicHeartbeat = operation;
      void operation.then(
        () => {
          if (this.periodicHeartbeat === operation) {
            this.periodicHeartbeat = undefined;
          }
        },
        () => {
          if (this.periodicHeartbeat === operation) {
            this.periodicHeartbeat = undefined;
          }
        },
      );
    }, this.heartbeatIntervalMs);
    this.heartbeatInterval.unref();

    this.reconciliationInterval = setInterval(() => {
      if (this.periodicReconciliation !== undefined) {
        return;
      }
      const operation = this.reconciler.runOnce();
      this.periodicReconciliation = operation;
      void operation.then(
        () => {
          if (this.periodicReconciliation === operation) {
            this.periodicReconciliation = undefined;
          }
        },
        () => {
          if (this.periodicReconciliation === operation) {
            this.periodicReconciliation = undefined;
          }
          this.logger.error(
            { event: "deployment_job_reconciliation_failed" },
            "Deployment job reconciliation pass failed safely",
          );
        },
      );
    }, this.reconciliationIntervalMs);
    this.reconciliationInterval.unref();
  }

  private clearIntervals(): void {
    if (this.heartbeatInterval !== undefined) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }
    if (this.reconciliationInterval !== undefined) {
      clearInterval(this.reconciliationInterval);
      this.reconciliationInterval = undefined;
    }
  }

  public async start(): Promise<void> {
    if (this.state !== "created") {
      throw new Error("Deployment worker runtime can only be started once");
    }

    this.state = "starting";
    await this.queueHeartbeat("starting", true);
    this.assertStarting();
    await this.publisher.waitUntilReady();
    this.assertStarting();
    await this.consumer.waitUntilReady();
    this.assertStarting();
    await this.reconciler.runOnce();
    this.assertStarting();
    await this.queueHeartbeat("ready", true);
    this.assertStarting();
    this.consumer.start();
    this.state = "ready";
    this.beginIntervals();
    this.logger.info(
      { event: "worker_ready", workerId: this.workerId },
      "Deployment worker is ready",
    );
  }

  public stop(): Promise<void> {
    this.stopPromise ??= this.stopOnce();
    return this.stopPromise;
  }

  private assertStarting(): void {
    if (this.state !== "starting") {
      throw new Error("Deployment worker startup was interrupted");
    }
  }

  private async stopOnce(): Promise<void> {
    if (this.state === "stopped") {
      return;
    }
    const initialState = this.state;
    const interruptedStartup = initialState === "created" || initialState === "starting";
    const deadline = Date.now() + this.shutdownGraceMs;
    this.state = "stopping";
    this.clearIntervals();

    if (interruptedStartup) {
      this.consumer.cancelActive();
      const heartbeatLifecycle =
        initialState === "created"
          ? Promise.resolve()
          : ignoreFailure(
              (async () => {
                await this.heartbeatWrites;
                await this.queueHeartbeat("draining");
                await this.queueHeartbeat("stopped");
              })(),
            );
      await settleBeforeDeadline(
        Promise.allSettled([heartbeatLifecycle, this.consumer.close(true), this.publisher.close()]),
        deadline,
      );
      this.state = "stopped";
      return;
    }

    let drained = false;
    let processorIdle = false;
    const pause = ignoreFailure(this.consumer.pause());
    const heartbeatLifecycle = ignoreFailure(
      (async () => {
        await this.heartbeatWrites;
        await this.queueHeartbeat("draining");
      })(),
    );
    const reconciliation = ignoreFailure(this.reconciler.waitForIdle());
    const drain = pause
      .then(() => this.consumer.drain())
      .then(
        async () => {
          drained = true;
          await this.processor.waitForIdle();
          processorIdle = true;
        },
        () => undefined,
      );
    const gracefulWorkSettled = await settleBeforeDeadline(
      Promise.all([pause, heartbeatLifecycle, reconciliation, drain]),
      deadline,
    );
    const cleanlyDrained =
      gracefulWorkSettled && drained && processorIdle && this.processor.getActiveJobCount() === 0;

    if (!cleanlyDrained) {
      this.logger.warn(
        { event: "worker_shutdown_deadline", workerId: this.workerId },
        "Worker shutdown deadline reached; active leases remain recoverable",
      );
      this.consumer.cancelActive();
    }

    const cleanup = Promise.allSettled([
      this.consumer.close(!cleanlyDrained),
      this.publisher.close(),
      ...(cleanlyDrained ? [this.queueHeartbeat("stopped")] : []),
    ]);
    await settleBeforeDeadline(cleanup, deadline);
    this.state = "stopped";
    this.logger.info(
      { event: "worker_stopped", workerId: this.workerId },
      "Deployment worker stopped",
    );
  }
}
