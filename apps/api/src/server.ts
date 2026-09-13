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
  });
  server.addHook("onResponse", async (request, reply) => {
    metrics.increment("launchrail_http_requests_total", {
      method: request.method,
      status_class: `${Math.floor(reply.statusCode / 100)}xx`,
      route: request.routeOptions.url ?? "unknown",
    });
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
        const signature = request.headers["x-hub-signature-256"];
        const deliveryId = request.headers["x-github-delivery"];
        const eventName = request.headers["x-github-event"];
        if (deliveryId === undefined || eventName === undefined)
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
        });
        if (!verified)
          return reply.code(401).send({
            error: { code: "invalid_signature", message: "GitHub signature verification failed" },
          });
        if (eventName !== "push")
          return reply.code(400).send({
            error: { code: "unsupported_event", message: "GitHub event is not supported" },
          });
        if (eventName === "push" && parsed === null)
          return reply.code(400).send({
            error: { code: "invalid_request", message: "Invalid GitHub push payload" },
          });
        if (
          eventName === "push" &&
          parsed !== null &&
          !delivery.duplicate &&
          webhookTrigger !== undefined
        )
          await webhookTrigger.trigger({ deliveryId, organizationId, push: parsed });
        return reply
          .code(delivery.duplicate ? 200 : 202)
          .send({ delivery, ...(parsed === null ? {} : { push: parsed }) });
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
        ...(transitionStore === undefined ? {} : { transitionStore }),
        secureCookies,
        signInRateLimitMax,
        webOrigin,
      });
    });
  }

  server.setErrorHandler((error, request, reply) => {
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
