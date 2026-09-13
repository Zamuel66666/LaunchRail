import { createServer, type Server } from "node:http";

import { createHealthResponse } from "@launchrail/contracts";
import type { MetricsRegistry } from "@launchrail/observability";

interface WorkerHealthServerOptions {
  readonly metrics?: MetricsRegistry;
  readonly now?: () => Date;
  readonly version?: string;
}

export function createWorkerHealthServer({
  metrics,
  now,
  version = "0.1.0",
}: WorkerHealthServerOptions = {}): Server {
  return createServer((request, response) => {
    if (request.method === "GET" && request.url === "/metrics") {
      response.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
      response.end(
        `launchrail_worker_process_uptime_seconds ${process.uptime()}\n` +
          `launchrail_worker_process_resident_memory_bytes ${process.memoryUsage().rss}\n` +
          (metrics?.renderPrometheus() ?? ""),
      );
      return;
    }
    if (request.method !== "GET" || request.url !== "/health") {
      response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "not_found" }));
      return;
    }

    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(createHealthResponse({ now, service: "worker", version })));
  });
}

export async function listenForWorkerHealth(
  server: Server,
  host: string,
  port: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

export async function closeWorkerHealthServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}
