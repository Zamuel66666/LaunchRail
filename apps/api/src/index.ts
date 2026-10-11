import { tracingRuntime } from "./tracing-bootstrap.js";

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
  traceDatabaseStore,
} from "@launchrail/database";
import { BullMqDeploymentQueuePublisher } from "@launchrail/queue";
import { parseDeploymentJob } from "@launchrail/contracts";

import { buildServer } from "./server.js";
import { createGitHubWebhookDeploymentTrigger } from "./webhook-trigger.js";

async function readBoundedResponse(response: Response, maximumBytes: number): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel();
        throw new Error("Worker runtime log response exceeded its safe bound");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

async function main(): Promise<void> {
  const config = loadApiConfig();
  const databaseClient = createDatabaseClient(config.DATABASE_URL);
  const identityStore = traceDatabaseStore(
    new PostgresIdentityStore(databaseClient.db, {
      absoluteTtlMs: config.SESSION_ABSOLUTE_TTL_HOURS * 60 * 60 * 1000,
      idleTtlMs: config.SESSION_IDLE_TTL_MINUTES * 60 * 1000,
    }),
    "identity",
  );
  const secretCipher = new AesGcmSecretCipher(
    config.LAUNCHRAIL_SECRET_KEYRING,
    config.LAUNCHRAIL_ACTIVE_SECRET_KEY_VERSION,
  );
  const projectStore = traceDatabaseStore(
    new PostgresProjectManagementStore(databaseClient.db, secretCipher),
    "projects",
  );
  const deploymentStore = traceDatabaseStore(
    new PostgresDeploymentJobStore(databaseClient.db),
    "deployment_jobs",
  );
  const transitionStore = traceDatabaseStore(
    new PostgresDeploymentTransitionStore(databaseClient.db),
    "deployment_transitions",
  );
  const webhookStore = traceDatabaseStore(
    new PostgresWebhookDeliveryStore(databaseClient.db),
    "webhooks",
  );
  const deploymentCreationStore = traceDatabaseStore(
    new PostgresDeploymentCreationStore(databaseClient.db),
    "deployment_creation",
  );
  const deploymentPublisher = new BullMqDeploymentQueuePublisher({
    onInfrastructureEvent: (event) => {
      process.stderr.write(`LaunchRail queue ${event.component}: ${event.code}\n`);
    },
    prefix: config.WORKER_QUEUE_PREFIX,
    queueName: config.WORKER_QUEUE_NAME,
    redisUrl: config.REDIS_URL,
  });
  const workerInternalToken = config.WORKER_INTERNAL_TOKEN;
  const webhookTrigger =
    config.GITHUB_WEBHOOK_SECRET === undefined
      ? undefined
      : createGitHubWebhookDeploymentTrigger({
          deploymentCreationStore,
          deploymentJobStore: deploymentStore,
          maxAttempts: config.GITHUB_WEBHOOK_MAX_ATTEMPTS,
          onDispatchFailure: ({ deploymentId }) => {
            process.stderr.write(`LaunchRail webhook dispatch deferred for ${deploymentId}\n`);
          },
          projectStore,
          publisher: deploymentPublisher,
        });
  const server = buildServer({
    cookieName: config.SESSION_COOKIE_NAME,
    identityStore,
    logger: serviceLoggerOptions("api", config.LOG_LEVEL),
    projectStore,
    deploymentStore,
    ...(workerInternalToken === undefined
      ? {}
      : {
          runtimeLogReader: async ({ deploymentId, organizationId, tail }) => {
            const workerUrl = new URL("/internal/runtime-logs", config.WORKER_INTERNAL_URL);
            workerUrl.searchParams.set("deploymentId", deploymentId);
            workerUrl.searchParams.set("organizationId", organizationId);
            workerUrl.searchParams.set("tail", String(tail));
            const response = await fetch(workerUrl, {
              headers: { "x-launchrail-internal-token": workerInternalToken },
              redirect: "error",
              signal: AbortSignal.timeout(6_000),
            });
            if (response.status === 404) return null;
            if (!response.ok) throw new Error("Worker runtime log request failed");
            const body = await readBoundedResponse(response, 280_000);
            const parsed: unknown = JSON.parse(body);
            if (
              typeof parsed !== "object" ||
              parsed === null ||
              !("logs" in parsed) ||
              typeof parsed.logs !== "string" ||
              Buffer.byteLength(parsed.logs, "utf8") > 262_144
            )
              throw new Error("Worker runtime log response was invalid");
            return parsed.logs;
          },
        }),
    deploymentCreationStore,
    readinessCheck: () => databaseClient.checkReady(),
    deploymentWakeup: async ({ deploymentId, organizationId, traceHeaders }) => {
      try {
        const ensured = await deploymentStore.ensurePendingClaim({
          availableAt: new Date(),
          deploymentId,
          maxAttempts: config.WORKER_MAX_ATTEMPTS,
          organizationId,
        });
        if (ensured.kind === "deployment_not_found" || ensured.kind === "deployment_ineligible")
          return;
        await deploymentPublisher.enqueue(
          parseDeploymentJob({
            contractVersion: 1,
            kind: "deployment.claim",
            workItemId: ensured.job.id,
          }),
          traceHeaders,
        );
      } catch {
        // The database remains authoritative; worker reconciliation recreates the wake-up.
      }
    },
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
  server.addHook("onClose", async () => deploymentPublisher.close());
  server.addHook("onClose", async () => {
    await tracingRuntime.shutdown().catch(() => {
      server.log.warn("OTLP trace exporter shutdown failed");
    });
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
    error instanceof ConfigurationError
      ? error.message
      : `LaunchRail API failed to start: ${error instanceof Error ? error.message : "unknown error"}`;
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
  await tracingRuntime.shutdown().catch(() => undefined);
}
