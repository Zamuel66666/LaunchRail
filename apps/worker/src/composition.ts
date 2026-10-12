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
import {
  PostgresDeploymentJobStore,
  PostgresDeploymentTransitionStore,
  PostgresRollbackStore,
  traceDatabaseStore,
  type LaunchRailDatabase,
} from "@launchrail/database";
import type { MetricsRegistry } from "@launchrail/observability";
import {
  BullMqDeploymentQueueConsumer,
  BullMqDeploymentQueuePublisher,
  type QueueInfrastructureEvent,
} from "@launchrail/queue";
import { GitHubRepositoryProvider, HardenedGitRepositoryCheckout } from "@launchrail/source";
import { checkHttpHealth, DockerDeploymentRuntimeManager } from "@launchrail/runtime";
import { TraefikFileRouteManager } from "@launchrail/routing";

import { DeploymentJobProcessor } from "./job-processor.js";
import { DeploymentBuildProcessor } from "./build-processor.js";
import { DeploymentClaimProcessor, type WorkerEventLogger } from "./processor.js";
import { DeploymentJobReconciler } from "./reconciler.js";
import { createStageHandoffHandler } from "./stage-handoff.js";
import { DeploymentWorkerRuntime } from "./runtime.js";
import { DeploymentSourceProcessor } from "./source-processor.js";
import { DeploymentRuntimeProcessor } from "./runtime-processor.js";
import { DeploymentRollbackProcessor } from "./rollback-processor.js";

export interface DeploymentWorkerComponents {
  readonly buildProcessor: DeploymentBuildProcessor;
  readonly consumer: BullMqDeploymentQueueConsumer;
  readonly claimProcessor: DeploymentClaimProcessor;
  readonly processor: DeploymentJobProcessor;
  readonly publisher: BullMqDeploymentQueuePublisher;
  readonly reconciler: DeploymentJobReconciler;
  readonly runtime: DeploymentWorkerRuntime;
  readonly runtimeManager: DeploymentRuntimeManager;
  readonly sourceProcessor: DeploymentSourceProcessor;
  readonly runtimeProcessor: DeploymentRuntimeProcessor;
  readonly store: DeploymentJobStore;
}

export interface CreateDeploymentWorkerComponentsOptions {
  readonly imageBuilder?: ImageBuilder;
  readonly config: WorkerConfig;
  readonly database: LaunchRailDatabase;
  readonly logger: WorkerEventLogger;
  readonly metrics?: MetricsRegistry;
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
  metrics,
  imageBuilder,
  repositoryCheckout,
  repositoryProvider,
  runtimeManager,
  version,
  workerId,
}: CreateDeploymentWorkerComponentsOptions): DeploymentWorkerComponents {
  const store = traceDatabaseStore(
    new PostgresDeploymentJobStore(database, metrics === undefined ? {} : { metrics }),
    "deployment_jobs",
  );
  const transitionStore = traceDatabaseStore(
    new PostgresDeploymentTransitionStore(database, metrics),
    "deployment_transitions",
  );
  const deploymentRuntimeManager =
    runtimeManager ??
    new DockerDeploymentRuntimeManager({
      dockerConfigDirectory: join(config.WORKER_BUILD_ROOT, "runtime-docker-config"),
      timeoutMs: config.WORKER_RUNTIME_TIMEOUT_MS,
    });
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
  const deploymentImageBuilder =
    imageBuilder ??
    new BuildKitImageBuilder({
      buildRootDirectory: config.WORKER_BUILD_ROOT,
      builderName: config.WORKER_BUILDX_BUILDER_NAME,
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
    });
  const buildProcessor = new DeploymentBuildProcessor({
    backoffBaseMs: config.WORKER_BACKOFF_BASE_MS,
    backoffCapMs: config.WORKER_BACKOFF_CAP_MS,
    heartbeatIntervalMs: config.WORKER_HEARTBEAT_INTERVAL_MS,
    imageBuilder: deploymentImageBuilder,
    jobTimeoutMs: config.WORKER_JOB_TIMEOUT_MS,
    leaseDurationMs: config.WORKER_LEASE_MS,
    logMaxRetainedBytes: config.WORKER_BUILD_LOG_MAX_BYTES,
    logger,
    ...(metrics === undefined ? {} : { metrics }),
    repositoryCheckout: checkout,
    sourceRoot: config.WORKER_SOURCE_ROOT,
    store,
    workerId,
  });
  const runtimeProcessor = new DeploymentRuntimeProcessor({
    backoffBaseMs: config.WORKER_BACKOFF_BASE_MS,
    backoffCapMs: config.WORKER_BACKOFF_CAP_MS,
    heartbeatIntervalMs: config.WORKER_HEARTBEAT_INTERVAL_MS,
    jobTimeoutMs: config.WORKER_JOB_TIMEOUT_MS,
    leaseDurationMs: config.WORKER_LEASE_MS,
    logger,
    ...(metrics === undefined ? {} : { metrics }),
    healthCheck: checkHttpHealth,
    healthGraceMs: config.WORKER_HEALTH_GRACE_MS,
    routeManager: new TraefikFileRouteManager({
      configurationDirectory: config.WORKER_TRAEFIK_DYNAMIC_CONFIG_DIR,
    }),
    runtimeManager: deploymentRuntimeManager,
    store,
    transitionStore,
    workerId,
  });
  const rollbackProcessor = new DeploymentRollbackProcessor({
    store: traceDatabaseStore(new PostgresRollbackStore(database, metrics), "rollbacks"),
    runtimeManager: deploymentRuntimeManager,
    healthCheck: checkHttpHealth,
    workerId,
    leaseDurationMs: config.WORKER_LEASE_MS,
    heartbeatIntervalMs: config.WORKER_HEARTBEAT_INTERVAL_MS,
    jobTimeoutMs: config.WORKER_JOB_TIMEOUT_MS,
    healthGraceMs: config.WORKER_HEALTH_GRACE_MS,
    logger,
  });
  const processor = new DeploymentJobProcessor({
    rollbackProcessor,
    buildProcessor,
    claimProcessor,
    ...(metrics === undefined ? {} : { metrics }),
    runtimeProcessor,
    sourceProcessor,
  });
  const consumer = new BullMqDeploymentQueueConsumer({
    ...queueOptions,
    concurrency: config.WORKER_CONCURRENCY,
    handler: createStageHandoffHandler({
      processor,
      store,
      publisher,
      logger,
      ...(metrics === undefined ? {} : { metrics }),
    }),
    ...(metrics === undefined ? {} : { metrics }),
  });
  const reconciler = new DeploymentJobReconciler({
    rollbackProcessor,
    batchSize: config.WORKER_RECONCILIATION_BATCH_SIZE,
    logger,
    maxAttempts: config.WORKER_MAX_ATTEMPTS,
    imageBuilder: deploymentImageBuilder,
    ...(metrics === undefined ? {} : { metrics }),
    publisher,
    store,
    transitionStore,
    routeManager: new TraefikFileRouteManager({
      configurationDirectory: config.WORKER_TRAEFIK_DYNAMIC_CONFIG_DIR,
    }),
    runtimeManager: deploymentRuntimeManager,
    repositoryCheckout: checkout,
  });
  const runtime = new DeploymentWorkerRuntime({
    consumer,
    heartbeatIntervalMs: config.WORKER_HEARTBEAT_INTERVAL_MS,
    infrastructureReady: async () => {
      const [builderReady, runtimeReady] = await Promise.all([
        deploymentImageBuilder.checkReady?.() ?? Promise.resolve(true),
        deploymentRuntimeManager.checkReady?.() ?? Promise.resolve(true),
      ]);
      return builderReady && runtimeReady;
    },
    logger,
    ...(metrics === undefined ? {} : { metrics }),
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
    runtimeManager: deploymentRuntimeManager,
    sourceProcessor,
    runtimeProcessor,
    store,
  };
}
