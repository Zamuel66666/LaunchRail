import { ConfigurationError, loadWorkerConfig } from "@launchrail/config";
import { createServiceLogger } from "@launchrail/observability";

import {
  closeWorkerHealthServer,
  createWorkerHealthServer,
  listenForWorkerHealth,
} from "./health-server.js";

async function main(): Promise<void> {
  const config = loadWorkerConfig();
  const logger = createServiceLogger("worker", config.LOG_LEVEL);
  const healthServer = createWorkerHealthServer({ version: "0.1.0" });

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    logger.info({ signal }, "Worker shutdown requested");
    await closeWorkerHealthServer(healthServer);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  await listenForWorkerHealth(healthServer, config.WORKER_HEALTH_HOST, config.WORKER_HEALTH_PORT);
  logger.info(
    { host: config.WORKER_HEALTH_HOST, port: config.WORKER_HEALTH_PORT },
    "Worker health server listening",
  );
}

try {
  await main();
} catch (error) {
  const message =
    error instanceof ConfigurationError
      ? error.message
      : `LaunchRail worker failed to start: ${error instanceof Error ? error.message : "unknown error"}`;
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
