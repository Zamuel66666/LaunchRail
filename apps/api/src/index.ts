import { ConfigurationError, loadApiConfig } from "@launchrail/config";
import { serviceLoggerOptions } from "@launchrail/observability";

import { buildServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadApiConfig();
  const server = buildServer({
    logger: serviceLoggerOptions("api", config.LOG_LEVEL),
    version: "0.1.0",
  });

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    server.log.info({ signal }, "API shutdown requested");
    await server.close();
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  await server.listen({ host: config.API_HOST, port: config.API_PORT });
}

try {
  await main();
} catch (error) {
  const message =
    error instanceof ConfigurationError ? error.message : "LaunchRail API failed to start";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
