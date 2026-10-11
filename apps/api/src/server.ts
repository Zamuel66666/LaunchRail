import { createHealthResponse } from "@launchrail/contracts";
import type {
  DeploymentJobStore,
  DeploymentCreationStore,
  DeploymentTransitionStore,
  IdentityStore,
  ProjectManagementStore,
  WebhookDeliveryStore,
  WebhookDeploymentTrigger,
} from "@launchrail/application";
import { parseGitHubPushEvent, verifyGitHubSignature } from "@launchrail/application";
import { DeploymentNotFoundError, DeploymentPersistenceConflictError } from "@launchrail/database";
import { MetricsRegistry } from "@launchrail/observability";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";

import { registerAuthRoutes } from "./auth-routes.js";

interface BuildServerOptions {
  readonly cookieName?: string;
  readonly identityStore?: IdentityStore;
  readonly logger?: FastifyServerOptions["logger"];
  readonly now?: () => Date;
  readonly projectStore?: ProjectManagementStore;
  readonly deploymentStore?: DeploymentJobStore;
  readonly deploymentCreationStore?: DeploymentCreationStore;
  readonly deploymentWakeup?: (deployment: {
    readonly deploymentId: string;
    readonly organizationId: string;
  }) => Promise<void>;
  readonly transitionStore?: DeploymentTransitionStore;
  readonly secureCookies?: boolean;
  readonly signInRateLimitMax?: number;
  readonly version?: string;
  readonly webOrigin?: string;
  readonly webhookSecret?: string;
  readonly webhookStore?: WebhookDeliveryStore;
  readonly webhookOrganizationId?: string;
  readonly webhookTrigger?: WebhookDeploymentTrigger;
}

export function buildServer({
  cookieName = "launchrail_session",
  identityStore,
  logger = false,
  now,
  projectStore,
  deploymentStore,
  deploymentCreationStore,
  deploymentWakeup,
  transitionStore,
  secureCookies = false,
  signInRateLimitMax = 5,
  version = "0.1.0",
  webOrigin = "http://localhost:3000",
  webhookSecret,
  webhookStore,
  webhookOrganizationId,
  webhookTrigger,
}: BuildServerOptions = {}): FastifyInstance {
  // A 16 KiB secret can expand substantially when JSON escapes control characters.
  // Route schemas and domain validation still enforce the decoded field limits.
  const server = Fastify({
    ajv: { customOptions: { removeAdditional: false } },
    bodyLimit: 131_072,
    logger,
  });
  const metrics = new MetricsRegistry();
  server.addHook("preParsing", async (request, _reply, payload) => {
    if (request.url !== "/v1/webhooks/github") return payload;
    const chunks: Buffer[] = [];
    for await (const chunk of payload)
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const rawBody = Buffer.concat(chunks);
    (request as typeof request & { rawBody?: Uint8Array }).rawBody = rawBody;
    const replay = Readable.from(rawBody) as Readable & { receivedEncodedLength?: number };
    replay.receivedEncodedLength = rawBody.length;
    return replay;
  });
  server.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
    (request as typeof request & { startedAt?: number }).startedAt = performance.now();
  });
  server.addHook("onResponse", async (request, reply) => {
    const startedAt = (request as typeof request & { startedAt?: number }).startedAt;
    metrics.increment("launchrail_http_requests_total", {
      method: request.method,
      status_class: `${Math.floor(reply.statusCode / 100)}xx`,
      route: request.routeOptions.url ?? "unknown",
    });
    if (startedAt !== undefined)
      metrics.observe(
        "launchrail_http_request_duration_seconds",
        (performance.now() - startedAt) / 1_000,
        {
          method: request.method,
          status_class: `${Math.floor(reply.statusCode / 100)}xx`,
          route: request.routeOptions.url ?? "unknown",
        },
      );
  });
  server.get("/metrics", async (_request, reply) =>
    reply.type("text/plain; version=0.0.4").send(metrics.renderPrometheus()),
  );

  void server.register(cookie);
  void server.register(cors, {
    credentials: true,
    methods: ["DELETE", "GET", "PATCH", "POST", "PUT"],
    origin: webOrigin,
  });
  void server.register(helmet);
  void server.register(rateLimit, { global: false });

  server.get("/health", async () => createHealthResponse({ now, service: "api", version }));

  if (
    webhookSecret !== undefined &&
    webhookStore !== undefined &&
    webhookOrganizationId !== undefined
  ) {
    server.post<{ Body: unknown; Headers: Record<string, string | undefined> }>(
      "/v1/webhooks/github",
      async (request, reply) => {
        const startedAt = performance.now();
        const recordWebhookMetric = (outcome: "duplicate" | "failed" | "ignored" | "processed") => {
          metrics.increment("launchrail_webhook_deliveries_total", {
            event: request.headers["x-github-event"] === "push" ? "push" : "other",
            outcome,
          });
          metrics.observe(
            "launchrail_webhook_processing_duration_seconds",
            (performance.now() - startedAt) / 1_000,
            { outcome },
          );
        };
        const signature = request.headers["x-hub-signature-256"];
        const deliveryId = request.headers["x-github-delivery"];
        const eventName = request.headers["x-github-event"];
        if (
          deliveryId === undefined ||
          deliveryId.length > 100 ||
          !/^[A-Za-z0-9-]+$/.test(deliveryId) ||
          eventName === undefined ||
          eventName.length > 100
        )
          return reply.code(400).send({
            error: { code: "invalid_request", message: "Missing GitHub delivery headers" },
          });
        const raw =
          (request as typeof request & { rawBody?: Uint8Array }).rawBody ??
          new TextEncoder().encode(JSON.stringify(request.body ?? null));
        const verified = await verifyGitHubSignature(raw, signature, webhookSecret);
        const payloadDigest = Array.from(
          new Uint8Array(
            await globalThis.crypto.subtle.digest(
              "SHA-256",
              new Uint8Array(raw).buffer as ArrayBuffer,
            ),
          ),
          (byte) => byte.toString(16).padStart(2, "0"),
        ).join("");
        const parsed = verified && eventName === "push" ? parseGitHubPushEvent(request.body) : null;
        const organizationId = webhookOrganizationId;
        if (organizationId === undefined)
          return reply
            .code(400)
            .send({ error: { code: "invalid_request", message: "Missing organization header" } });
        const delivery = await webhookStore.record({
          deliveryId,
          eventName,
          organizationId,
          payloadDigest,
          provider: "github",
          verificationState:
            verified && (eventName !== "push" || parsed !== null) ? "verified" : "rejected",
          ...(verified && parsed !== null ? { push: parsed } : {}),
        });
        if (delivery.duplicate) {
          recordWebhookMetric("duplicate");
          if (!verified)
            return reply.code(401).send({
              error: {
                code: "invalid_signature",
                message: "GitHub signature verification failed",
              },
            });
          return reply.code(200).send({ delivery });
        }
        if (!verified) {
          recordWebhookMetric("failed");
          await webhookStore.mark({
            deliveryId,
            organizationId,
            processingError: "invalid_signature",
            processingState: "failed",
          });
          return reply.code(401).send({
            error: { code: "invalid_signature", message: "GitHub signature verification failed" },
          });
        }
        if (eventName !== "push") {
          recordWebhookMetric("ignored");
          await webhookStore.mark({
            deliveryId,
            organizationId,
            processingError: "unsupported_event",
            processingState: "ignored",
          });
          return reply.code(400).send({
            error: { code: "unsupported_event", message: "GitHub event is not supported" },
          });
        }
        if (parsed === null) {
          recordWebhookMetric("failed");
          await webhookStore.mark({
            deliveryId,
            organizationId,
            processingError: "invalid_payload",
            processingState: "failed",
          });
          return reply.code(400).send({
            error: { code: "invalid_request", message: "Invalid GitHub push payload" },
          });
        }
        if (webhookTrigger === undefined) {
          recordWebhookMetric("failed");
          await webhookStore.mark({
            deliveryId,
            organizationId,
            processingError: "trigger_unavailable",
            processingState: "failed",
          });
          return reply.code(503).send({
            error: { code: "trigger_unavailable", message: "Webhook processing is unavailable" },
          });
        }
        try {
          await webhookTrigger.trigger({ deliveryId, organizationId, push: parsed });
          recordWebhookMetric("processed");
          const processed = await webhookStore.mark({
            deliveryId,
            organizationId,
            processingState: "processed",
          });
          return reply.code(202).send({ delivery: processed, push: parsed });
        } catch (error) {
          recordWebhookMetric("failed");
          request.log.warn({ error, requestId: request.id }, "GitHub webhook processing failed");
          const failed = await webhookStore.mark({
            deliveryId,
            organizationId,
            processingError: "trigger_failed",
            processingState: "failed",
          });
          return reply.code(503).send({ delivery: failed });
        }
      },
    );
  }

  if (identityStore !== undefined) {
    void server.register(async (authServer) => {
      registerAuthRoutes(authServer, {
        cookieName,
        identityStore,
        now: now ?? (() => new Date()),
        ...(projectStore === undefined ? {} : { projectStore }),
        ...(deploymentStore === undefined ? {} : { deploymentStore }),
        ...(deploymentCreationStore === undefined ? {} : { deploymentCreationStore }),
        ...(deploymentWakeup === undefined ? {} : { deploymentWakeup }),
        ...(transitionStore === undefined ? {} : { transitionStore }),
        ...(webhookStore === undefined ? {} : { webhookDeliveryStore: webhookStore }),
        ...(webhookTrigger === undefined ? {} : { webhookTrigger }),
        secureCookies,
        signInRateLimitMax,
        webOrigin,
      });
    });
  }

  server.setErrorHandler((error, request, reply) => {
    if (error instanceof DeploymentNotFoundError) {
      void reply.code(404).send({
        error: { code: "deployment_not_found", message: "Deployment was not found" },
      });
      return;
    }
    if (error instanceof DeploymentPersistenceConflictError) {
      void reply.code(409).send({
        error: { code: "deployment_conflict", message: error.message },
      });
      return;
    }
    if (typeof error === "object" && error !== null && "validation" in error) {
      void reply.code(400).send({
        error: { code: "invalid_request", message: "Request validation failed" },
      });
      return;
    }
    if (
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      error.statusCode === 429
    ) {
      void reply.code(429).send({
        error: { code: "rate_limited", message: "Too many requests; try again later" },
      });
      return;
    }

    request.log.error({ error }, "Unhandled API error");
    void reply.code(500).send({
      error: { code: "internal_error", message: "An internal error occurred" },
    });
  });

  return server;
}
import { Readable } from "node:stream";
