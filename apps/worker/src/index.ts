import { randomUUID } from "node:crypto";

import { ConfigurationError, loadWorkerConfig } from "@launchrail/config";
import { createDatabaseClient, type DatabaseClient } from "@launchrail/database";
import { createServiceLogger } from "@launchrail/observability";

import { createDeploymentWorkerComponents } from "./composition.js";
import {
  closeWorkerHealthServer,
  createWorkerHealthServer,
  listenForWorkerHealth,
} from "./health-server.js";

const workerVersion = "0.1.0";

async function main(): Promise<void> {
  const config = loadWorkerConfig();
  const logger = createServiceLogger("worker", config.LOG_LEVEL);
  const healthServer = createWorkerHealthServer({ version: workerVersion });
  let databaseClosePromise: Promise<void> | undefined;
  let databaseClient: DatabaseClient | undefined;
  let healthClosePromise: Promise<void> | undefined;
  let runtime: ReturnType<typeof createDeploymentWorkerComponents>["runtime"] | undefined;
  let shutdownRequested = false;
  let shutdownPromise: Promise<void> | undefined;
  let markStartupFinished = (): void => undefined;
  const startupFinished = new Promise<void>((resolve) => {
    markStartupFinished = resolve;
  });

  const closeDatabase = async (): Promise<void> => {
    if (databaseClient === undefined) {
      return;
    }
    databaseClosePromise ??= databaseClient.close();
    await databaseClosePromise;
  };

  const closeHealth = async (): Promise<void> => {
    if (!healthServer.listening) {
      return;
    }
    healthClosePromise ??= closeWorkerHealthServer(healthServer);
    await healthClosePromise;
  };

  const finishShutdown = async (): Promise<void> => {
    try {
      await runtime?.stop();
    } finally {
      try {
        await closeDatabase();
      } finally {
        await closeHealth();
      }
    }
  };

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    shutdownRequested = true;
    shutdownPromise ??= (async () => {
      logger.info({ signal }, "Worker shutdown requested");
      const watchdog = setTimeout(() => {
        process.stderr.write("LaunchRail worker exceeded its shutdown deadline\n");
        process.exit(1);
      }, config.WORKER_SHUTDOWN_GRACE_MS);
      watchdog.unref();
      try {
        await finishShutdown();
        await startupFinished;
        await finishShutdown();
      } finally {
        clearTimeout(watchdog);
      }
    })();
    await shutdownPromise;
  };

  const requestShutdown = (signal: NodeJS.Signals): void => {
    void shutdown(signal).catch(() => {
      process.stderr.write("LaunchRail worker shutdown failed\n");
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", () => requestShutdown("SIGINT"));
  process.once("SIGTERM", () => requestShutdown("SIGTERM"));

  try {
    await listenForWorkerHealth(healthServer, config.WORKER_HEALTH_HOST, config.WORKER_HEALTH_PORT);
    if (shutdownRequested) {
      await finishShutdown();
      return;
    }
    logger.info(
      { host: config.WORKER_HEALTH_HOST, port: config.WORKER_HEALTH_PORT },
      "Worker health server listening",
    );

    if (config.WORKER_MODE === "health-only") {
      logger.info({ mode: config.WORKER_MODE }, "Worker queue runtime disabled for health smoke");
      return;
    }

    try {
      const databaseOperationTimeoutMs = Math.min(
        config.WORKER_JOB_TIMEOUT_MS,
        config.WORKER_SHUTDOWN_GRACE_MS,
      );
      databaseClient = createDatabaseClient({
        connectionString: config.DATABASE_URL,
        connectionTimeoutMillis: Math.min(databaseOperationTimeoutMs, 5_000),
        query_timeout: databaseOperationTimeoutMs,
        statement_timeout: databaseOperationTimeoutMs,
      });
      if (shutdownRequested) {
        await finishShutdown();
        return;
      }
      runtime = createDeploymentWorkerComponents({
        config,
        database: databaseClient.db,
        logger,
        version: workerVersion,
        workerId: `worker-${randomUUID()}`,
      }).runtime;
      if (shutdownRequested) {
        await finishShutdown();
        return;
      }
      await runtime.start();
    } catch (error) {
      if (shutdownRequested) {
        await finishShutdown();
        return;
      }
      await finishShutdown();
      throw error;
    }
  } finally {
    markStartupFinished();
  }
}

try {
  await main();
} catch (error) {
  const message =
    error instanceof ConfigurationError
      ? error.message
      : "LaunchRail worker failed to start; inspect structured worker logs for safe diagnostics";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
