import { ConfigurationError, loadApiConfig } from "@launchrail/config";
import { serviceLoggerOptions } from "@launchrail/observability";
import { createDatabaseClient, PostgresIdentityStore } from "@launchrail/database";

import { buildServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadApiConfig();
  const databaseClient = createDatabaseClient(config.DATABASE_URL);
  const identityStore = new PostgresIdentityStore(databaseClient.db, {
    absoluteTtlMs: config.SESSION_ABSOLUTE_TTL_HOURS * 60 * 60 * 1000,
    idleTtlMs: config.SESSION_IDLE_TTL_MINUTES * 60 * 1000,
  });
  const server = buildServer({
    cookieName: config.SESSION_COOKIE_NAME,
    identityStore,
    logger: serviceLoggerOptions("api", config.LOG_LEVEL),
    secureCookies: config.NODE_ENV === "production",
    signInRateLimitMax: config.SIGN_IN_RATE_LIMIT_MAX,
    version: "0.1.0",
    webOrigin: config.WEB_ORIGIN,
  });
  server.addHook("onClose", async () => databaseClient.close());

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
    error instanceof ConfigurationError
      ? error.message
      : `LaunchRail API failed to start: ${error instanceof Error ? error.message : "unknown error"}`;
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
