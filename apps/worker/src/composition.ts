import {
  PrepareRepository,
  type DeploymentJobStore,
  type RepositoryCheckout,
  type RepositoryProvider,
} from "@launchrail/application";
import type { WorkerConfig } from "@launchrail/config";
import { PostgresDeploymentJobStore, type LaunchRailDatabase } from "@launchrail/database";
import {
  BullMqDeploymentQueueConsumer,
  BullMqDeploymentQueuePublisher,
  type QueueInfrastructureEvent,
} from "@launchrail/queue";
import { GitHubRepositoryProvider, HardenedGitRepositoryCheckout } from "@launchrail/source";

import { DeploymentJobProcessor } from "./job-processor.js";
import { DeploymentClaimProcessor, type WorkerEventLogger } from "./processor.js";
import { DeploymentJobReconciler } from "./reconciler.js";
import { DeploymentWorkerRuntime } from "./runtime.js";
import { DeploymentSourceProcessor } from "./source-processor.js";

export interface DeploymentWorkerComponents {
  readonly consumer: BullMqDeploymentQueueConsumer;
  readonly claimProcessor: DeploymentClaimProcessor;
  readonly processor: DeploymentJobProcessor;
  readonly publisher: BullMqDeploymentQueuePublisher;
  readonly reconciler: DeploymentJobReconciler;
  readonly runtime: DeploymentWorkerRuntime;
  readonly sourceProcessor: DeploymentSourceProcessor;
  readonly store: DeploymentJobStore;
}

export interface CreateDeploymentWorkerComponentsOptions {
  readonly config: WorkerConfig;
  readonly database: LaunchRailDatabase;
  readonly logger: WorkerEventLogger;
  readonly repositoryCheckout?: RepositoryCheckout;
  readonly repositoryProvider?: RepositoryProvider;
  readonly version: string;
  readonly workerId: string;
}

export function createDeploymentWorkerComponents({
  config,
  database,
  logger,
  repositoryCheckout,
  repositoryProvider,
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
  const claimProcessor = new DeploymentClaimProcessor({
    backoffBaseMs: config.WORKER_BACKOFF_BASE_MS,
    backoffCapMs: config.WORKER_BACKOFF_CAP_MS,
    heartbeatIntervalMs: config.WORKER_HEARTBEAT_INTERVAL_MS,
    jobTimeoutMs: config.WORKER_JOB_TIMEOUT_MS,
    leaseDurationMs: config.WORKER_LEASE_MS,
    logger,
    store,
    workerId,
  });
  const sourceLimits = {
    maxApiResponseBytes: config.WORKER_SOURCE_RESOLVE_RESPONSE_BYTES,
    maxFileBytes: config.WORKER_SOURCE_MAX_FILE_BYTES,
    maxFileCount: config.WORKER_SOURCE_MAX_FILES,
    maxGitDirectoryBytes: config.WORKER_SOURCE_GIT_DIRECTORY_BYTES,
    maxPathBytes: config.WORKER_SOURCE_MAX_PATH_BYTES,
    maxProcessOutputBytes: config.WORKER_SOURCE_GIT_OUTPUT_BYTES,
    maxTotalBytes: config.WORKER_SOURCE_MAX_BYTES,
    maxTreeDepth: config.WORKER_SOURCE_MAX_DEPTH,
  } as const;
  const provider =
    repositoryProvider ??
    new GitHubRepositoryProvider({
      limits: sourceLimits,
      timeoutMs: config.WORKER_SOURCE_RESOLVE_TIMEOUT_MS,
    });
  const checkout =
    repositoryCheckout ??
    new HardenedGitRepositoryCheckout({
      limits: sourceLimits,
      rootDirectory: config.WORKER_SOURCE_ROOT,
    });
  const sourceProcessor = new DeploymentSourceProcessor({
    backoffBaseMs: config.WORKER_BACKOFF_BASE_MS,
    backoffCapMs: config.WORKER_BACKOFF_CAP_MS,
    heartbeatIntervalMs: config.WORKER_HEARTBEAT_INTERVAL_MS,
    jobTimeoutMs: config.WORKER_JOB_TIMEOUT_MS,
    leaseDurationMs: config.WORKER_LEASE_MS,
    logger,
    prepareRepository: new PrepareRepository({
      checkout,
      provider,
      timeoutMs: config.WORKER_SOURCE_CLONE_TIMEOUT_MS,
    }),
    store,
    workerId,
  });
  const processor = new DeploymentJobProcessor({ claimProcessor, sourceProcessor });
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

  return {
    claimProcessor,
    consumer,
    processor,
    publisher,
    reconciler,
    runtime,
    sourceProcessor,
    store,
  };
}
