import type { DeploymentJobStore } from "@launchrail/application";
import type { WorkerConfig } from "@launchrail/config";
import { PostgresDeploymentJobStore, type LaunchRailDatabase } from "@launchrail/database";
import {
  BullMqDeploymentQueueConsumer,
  BullMqDeploymentQueuePublisher,
  type QueueInfrastructureEvent,
} from "@launchrail/queue";

import { DeploymentClaimProcessor, type WorkerEventLogger } from "./processor.js";
import { DeploymentJobReconciler } from "./reconciler.js";
import { DeploymentWorkerRuntime } from "./runtime.js";

export interface DeploymentWorkerComponents {
  readonly consumer: BullMqDeploymentQueueConsumer;
  readonly processor: DeploymentClaimProcessor;
  readonly publisher: BullMqDeploymentQueuePublisher;
  readonly reconciler: DeploymentJobReconciler;
  readonly runtime: DeploymentWorkerRuntime;
  readonly store: DeploymentJobStore;
}

export interface CreateDeploymentWorkerComponentsOptions {
  readonly config: WorkerConfig;
  readonly database: LaunchRailDatabase;
  readonly logger: WorkerEventLogger;
  readonly version: string;
  readonly workerId: string;
}

export function createDeploymentWorkerComponents({
  config,
  database,
  logger,
  version,
  workerId,
}: CreateDeploymentWorkerComponentsOptions): DeploymentWorkerComponents {
  const store = new PostgresDeploymentJobStore(database);
  const queueOptions = {
    onInfrastructureEvent: (event: QueueInfrastructureEvent): void => {
      logger.error(
        { component: event.component, event: event.code },
        "Deployment queue infrastructure reported an error",
      );
    },
    prefix: config.WORKER_QUEUE_PREFIX,
    queueName: config.WORKER_QUEUE_NAME,
    redisUrl: config.REDIS_URL,
  } as const;
  const publisher = new BullMqDeploymentQueuePublisher(queueOptions);
  const processor = new DeploymentClaimProcessor({
    backoffBaseMs: config.WORKER_BACKOFF_BASE_MS,
    backoffCapMs: config.WORKER_BACKOFF_CAP_MS,
    heartbeatIntervalMs: config.WORKER_HEARTBEAT_INTERVAL_MS,
    jobTimeoutMs: config.WORKER_JOB_TIMEOUT_MS,
    leaseDurationMs: config.WORKER_LEASE_MS,
    logger,
    store,
    workerId,
  });
  const consumer = new BullMqDeploymentQueueConsumer({
    ...queueOptions,
    concurrency: config.WORKER_CONCURRENCY,
    handler: (job, signal) => processor.process(job, signal).then(() => undefined),
  });
  const reconciler = new DeploymentJobReconciler({
    batchSize: config.WORKER_RECONCILIATION_BATCH_SIZE,
    logger,
    maxAttempts: config.WORKER_MAX_ATTEMPTS,
    publisher,
    store,
  });
  const runtime = new DeploymentWorkerRuntime({
    consumer,
    heartbeatIntervalMs: config.WORKER_HEARTBEAT_INTERVAL_MS,
    logger,
    processor,
    publisher,
    reconciliationIntervalMs: config.WORKER_RECONCILIATION_INTERVAL_MS,
    reconciler,
    shutdownGraceMs: config.WORKER_SHUTDOWN_GRACE_MS,
    store,
    version,
    workerId,
  });

  return { consumer, processor, publisher, reconciler, runtime, store };
}
