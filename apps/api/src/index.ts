import { ConfigurationError, loadApiConfig } from "@launchrail/config";
import { serviceLoggerOptions } from "@launchrail/observability";
import {
  AesGcmSecretCipher,
  createDatabaseClient,
  PostgresIdentityStore,
  PostgresProjectManagementStore,
  PostgresDeploymentJobStore,
  PostgresDeploymentTransitionStore,
  PostgresWebhookDeliveryStore,
  PostgresDeploymentCreationStore,
} from "@launchrail/database";
import { BullMqDeploymentQueuePublisher } from "@launchrail/queue";

import { buildServer } from "./server.js";
import { createGitHubWebhookDeploymentTrigger } from "./webhook-trigger.js";

async function main(): Promise<void> {
  const config = loadApiConfig();
  const databaseClient = createDatabaseClient(config.DATABASE_URL);
  const identityStore = new PostgresIdentityStore(databaseClient.db, {
    absoluteTtlMs: config.SESSION_ABSOLUTE_TTL_HOURS * 60 * 60 * 1000,
    idleTtlMs: config.SESSION_IDLE_TTL_MINUTES * 60 * 1000,
  });
  const secretCipher = new AesGcmSecretCipher(
    config.LAUNCHRAIL_SECRET_KEYRING,
    config.LAUNCHRAIL_ACTIVE_SECRET_KEY_VERSION,
  );
  const projectStore = new PostgresProjectManagementStore(databaseClient.db, secretCipher);
  const deploymentStore = new PostgresDeploymentJobStore(databaseClient.db);
  const transitionStore = new PostgresDeploymentTransitionStore(databaseClient.db);
  const webhookStore = new PostgresWebhookDeliveryStore(databaseClient.db);
  const deploymentCreationStore = new PostgresDeploymentCreationStore(databaseClient.db);
  const webhookPublisher =
    config.GITHUB_WEBHOOK_SECRET === undefined
      ? undefined
      : new BullMqDeploymentQueuePublisher({
          onInfrastructureEvent: (event) => {
            process.stderr.write(`LaunchRail webhook queue ${event.component}: ${event.code}\n`);
          },
          prefix: config.WORKER_QUEUE_PREFIX,
          queueName: config.WORKER_QUEUE_NAME,
          redisUrl: config.REDIS_URL,
        });
  const webhookTrigger =
    webhookPublisher === undefined
      ? undefined
      : createGitHubWebhookDeploymentTrigger({
          deploymentCreationStore,
          deploymentJobStore: deploymentStore,
          maxAttempts: config.GITHUB_WEBHOOK_MAX_ATTEMPTS,
          onDispatchFailure: ({ deploymentId }) => {
            process.stderr.write(`LaunchRail webhook dispatch deferred for ${deploymentId}\n`);
          },
          projectStore,
          publisher: webhookPublisher,
        });
  const server = buildServer({
    cookieName: config.SESSION_COOKIE_NAME,
    identityStore,
    logger: serviceLoggerOptions("api", config.LOG_LEVEL),
    projectStore,
    deploymentStore,
    deploymentCreationStore,
    transitionStore,
    secureCookies: config.NODE_ENV === "production",
    signInRateLimitMax: config.SIGN_IN_RATE_LIMIT_MAX,
    version: "0.1.0",
    webOrigin: config.WEB_ORIGIN,
    webhookStore,
    ...(config.GITHUB_WEBHOOK_SECRET === undefined
      ? {}
      : { webhookSecret: config.GITHUB_WEBHOOK_SECRET }),
    ...(config.GITHUB_WEBHOOK_ORGANIZATION_ID === undefined
      ? {}
      : { webhookOrganizationId: config.GITHUB_WEBHOOK_ORGANIZATION_ID }),
    ...(webhookTrigger === undefined ? {} : { webhookTrigger }),
  });
  server.addHook("onClose", async () => databaseClient.close());
  server.addHook("onClose", async () => webhookPublisher?.close());

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
