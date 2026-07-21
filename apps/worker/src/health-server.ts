import { createServer, type Server } from "node:http";

import { createHealthResponse } from "@launchrail/contracts";

interface WorkerHealthServerOptions {
  readonly now?: () => Date;
  readonly version?: string;
}

export function createWorkerHealthServer({
  now,
  version = "0.1.0",
}: WorkerHealthServerOptions = {}): Server {
  return createServer((request, response) => {
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
