import { join } from "node:path";

import {
  PrepareRepository,
  type ImageBuilder,
  type DeploymentRuntimeManager,
  type DeploymentJobStore,
  type RepositoryCheckout,
  type RepositoryProvider,
} from "@launchrail/application";
import { BuildKitImageBuilder } from "@launchrail/build";
import type { WorkerConfig } from "@launchrail/config";
import { PostgresDeploymentJobStore, type LaunchRailDatabase } from "@launchrail/database";
import {
  BullMqDeploymentQueueConsumer,
  BullMqDeploymentQueuePublisher,
  type QueueInfrastructureEvent,
} from "@launchrail/queue";
import { GitHubRepositoryProvider, HardenedGitRepositoryCheckout } from "@launchrail/source";
import { DockerDeploymentRuntimeManager } from "@launchrail/runtime";

import { DeploymentJobProcessor } from "./job-processor.js";
import { DeploymentBuildProcessor } from "./build-processor.js";
import { DeploymentClaimProcessor, type WorkerEventLogger } from "./processor.js";
import { DeploymentJobReconciler } from "./reconciler.js";
import { DeploymentWorkerRuntime } from "./runtime.js";
import { DeploymentSourceProcessor } from "./source-processor.js";
import { DeploymentRuntimeProcessor } from "./runtime-processor.js";

export interface DeploymentWorkerComponents {
  readonly buildProcessor: DeploymentBuildProcessor;
  readonly consumer: BullMqDeploymentQueueConsumer;
  readonly claimProcessor: DeploymentClaimProcessor;
  readonly processor: DeploymentJobProcessor;
  readonly publisher: BullMqDeploymentQueuePublisher;
  readonly reconciler: DeploymentJobReconciler;
  readonly runtime: DeploymentWorkerRuntime;
  readonly sourceProcessor: DeploymentSourceProcessor;
  readonly runtimeProcessor: DeploymentRuntimeProcessor;
  readonly store: DeploymentJobStore;
}

export interface CreateDeploymentWorkerComponentsOptions {
  readonly imageBuilder?: ImageBuilder;
  readonly config: WorkerConfig;
  readonly database: LaunchRailDatabase;
  readonly logger: WorkerEventLogger;
  readonly repositoryCheckout?: RepositoryCheckout;
  readonly repositoryProvider?: RepositoryProvider;
  readonly runtimeManager?: DeploymentRuntimeManager;
  readonly version: string;
  readonly workerId: string;
}

export function createDeploymentWorkerComponents({
  config,
  database,
  logger,
  imageBuilder,
  repositoryCheckout,
  repositoryProvider,
  runtimeManager,
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
  const buildProcessor = new DeploymentBuildProcessor({
    backoffBaseMs: config.WORKER_BACKOFF_BASE_MS,
    backoffCapMs: config.WORKER_BACKOFF_CAP_MS,
    heartbeatIntervalMs: config.WORKER_HEARTBEAT_INTERVAL_MS,
    imageBuilder:
      imageBuilder ??
      new BuildKitImageBuilder({
        buildRootDirectory: config.WORKER_BUILD_ROOT,
        dockerConfigDirectory: join(config.WORKER_BUILD_ROOT, "docker-config"),
        platform: config.WORKER_BUILD_PLATFORM,
        timeoutMs: config.WORKER_BUILD_TIMEOUT_MS,
        limits: {
          cpuMillicores: config.WORKER_BUILD_CPU_MILLICORES,
          maxImageBytes: config.WORKER_BUILD_IMAGE_MAX_BYTES,
          maxInspectBytes: config.WORKER_BUILD_INSPECT_BYTES,
          maxLogBytes: config.WORKER_BUILD_LOG_MAX_BYTES,
          maxLogChunkBytes: config.WORKER_BUILD_LOG_CHUNK_BYTES,
          maxMetadataBytes: config.WORKER_BUILD_METADATA_BYTES,
          maxProgressBytes: config.WORKER_BUILD_PROGRESS_BYTES,
          maxProgressLineBytes: config.WORKER_BUILD_PROGRESS_LINE_BYTES,
          memoryMegabytes: config.WORKER_BUILD_MEMORY_MEGABYTES,
          processLimit: config.WORKER_BUILD_PROCESS_LIMIT,
          sharedMemoryMegabytes: config.WORKER_BUILD_SHARED_MEMORY_MEGABYTES,
        },
      }),
    jobTimeoutMs: config.WORKER_JOB_TIMEOUT_MS,
    leaseDurationMs: config.WORKER_LEASE_MS,
    logMaxRetainedBytes: config.WORKER_BUILD_LOG_MAX_BYTES,
    logger,
    repositoryCheckout: checkout,
    sourceRoot: config.WORKER_SOURCE_ROOT,
    store,
    workerId,
  });
  const runtimeProcessor = new DeploymentRuntimeProcessor({
    backoffBaseMs: config.WORKER_BACKOFF_BASE_MS,
    backoffCapMs: config.WORKER_BACKOFF_CAP_MS,
    heartbeatIntervalMs: config.WORKER_HEARTBEAT_INTERVAL_MS,
    jobTimeoutMs: config.WORKER_RUNTIME_TIMEOUT_MS,
    leaseDurationMs: config.WORKER_LEASE_MS,
    logger,
    runtimeManager:
      runtimeManager ??
      new DockerDeploymentRuntimeManager({
        dockerConfigDirectory: join(config.WORKER_BUILD_ROOT, "runtime-docker-config"),
        timeoutMs: config.WORKER_RUNTIME_TIMEOUT_MS,
      }),
    store,
    workerId,
  });
  const processor = new DeploymentJobProcessor({
    buildProcessor,
    claimProcessor,
    runtimeProcessor,
    sourceProcessor,
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

  return {
    buildProcessor,
    claimProcessor,
    consumer,
    processor,
    publisher,
    reconciler,
    runtime,
    sourceProcessor,
    runtimeProcessor,
    store,
  };
}
