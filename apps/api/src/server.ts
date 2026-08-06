import { createHealthResponse } from "@launchrail/contracts";
import type { IdentityStore, ProjectManagementStore } from "@launchrail/application";
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
  readonly secureCookies?: boolean;
  readonly signInRateLimitMax?: number;
  readonly version?: string;
  readonly webOrigin?: string;
}

export function buildServer({
  cookieName = "launchrail_session",
  identityStore,
  logger = false,
  now,
  projectStore,
  secureCookies = false,
  signInRateLimitMax = 5,
  version = "0.1.0",
  webOrigin = "http://localhost:3000",
}: BuildServerOptions = {}): FastifyInstance {
  // A 16 KiB secret can expand substantially when JSON escapes control characters.
  // Route schemas and domain validation still enforce the decoded field limits.
  const server = Fastify({
    ajv: { customOptions: { removeAdditional: false } },
    bodyLimit: 131_072,
    logger,
  });

  void server.register(cookie);
  void server.register(cors, {
    credentials: true,
    methods: ["DELETE", "GET", "PATCH", "POST", "PUT"],
    origin: webOrigin,
  });
  void server.register(helmet);
  void server.register(rateLimit, { global: false });

  server.get("/health", async () => createHealthResponse({ now, service: "api", version }));

  if (identityStore !== undefined) {
    void server.register(async (authServer) => {
      registerAuthRoutes(authServer, {
        cookieName,
        identityStore,
        now: now ?? (() => new Date()),
        ...(projectStore === undefined ? {} : { projectStore }),
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
