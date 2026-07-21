import { createHealthResponse } from "@launchrail/contracts";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";

interface BuildServerOptions {
  readonly logger?: FastifyServerOptions["logger"];
  readonly now?: () => Date;
  readonly version?: string;
}

export function buildServer({
  logger = false,
  now,
  version = "0.1.0",
}: BuildServerOptions = {}): FastifyInstance {
  const server = Fastify({ logger });

  server.get("/health", async () => createHealthResponse({ now, service: "api", version }));

  return server;
}
