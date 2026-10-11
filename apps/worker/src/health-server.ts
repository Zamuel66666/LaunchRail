import { timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";

import type { DeploymentRuntimeManager } from "@launchrail/application";
import { createHealthResponse } from "@launchrail/contracts";
import type { MetricsRegistry } from "@launchrail/observability";

interface WorkerHealthServerOptions {
  readonly metrics?: MetricsRegistry;
  readonly now?: () => Date;
  readonly version?: string;
}

export interface WorkerRuntimeLogAccess {
  readonly token: string;
  readonly runtimeManager: DeploymentRuntimeManager;
}

export interface WorkerHealthServer extends Server {
  configureRuntimeLogs(access: WorkerRuntimeLogAccess | undefined): void;
  configureReadiness(check: () => boolean): void;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function tokenMatches(expected: string, header: string | string[] | undefined): boolean {
  const actual = typeof header === "string" ? header : undefined;
  if (actual === undefined) return false;
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  return (
    expectedBytes.byteLength === actualBytes.byteLength &&
    timingSafeEqual(expectedBytes, actualBytes)
  );
}

export function createWorkerHealthServer({
  metrics,
  now,
  version = "0.1.0",
}: WorkerHealthServerOptions = {}): WorkerHealthServer {
  let runtimeLogAccess: WorkerRuntimeLogAccess | undefined;
  let readinessCheck = (): boolean => false;
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/metrics") {
      response.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
      response.end(
        `launchrail_worker_process_uptime_seconds ${process.uptime()}\n` +
          `launchrail_worker_process_resident_memory_bytes ${process.memoryUsage().rss}\n` +
          (metrics?.renderPrometheus() ?? ""),
      );
      return;
    }
    if (request.method === "GET" && request.url?.startsWith("/internal/runtime-logs?") === true) {
      void (async () => {
        const access = runtimeLogAccess;
        let url: URL;
        try {
          url = new URL(request.url ?? "/", "http://127.0.0.1");
        } catch {
          response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
          response.end(JSON.stringify({ error: "not_found" }));
          return;
        }
        const organizationId = url.searchParams.get("organizationId") ?? "";
        const deploymentId = url.searchParams.get("deploymentId") ?? "";
        const tailText = url.searchParams.get("tail") ?? "100";
        const tail = Number(tailText);
        if (
          access === undefined ||
          !tokenMatches(access.token, request.headers["x-launchrail-internal-token"]) ||
          !uuidPattern.test(organizationId) ||
          !uuidPattern.test(deploymentId) ||
          !/^(?:[1-9][0-9]{0,2})$/u.test(tailText) ||
          !Number.isSafeInteger(tail) ||
          tail > 200 ||
          url.searchParams.size !== 3 ||
          ["organizationId", "deploymentId", "tail"].some(
            (key) => url.searchParams.getAll(key).length !== 1,
          )
        ) {
          response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
          response.end(JSON.stringify({ error: "not_found" }));
          return;
        }
        if (access.runtimeManager.listManagedRuntimes === undefined) {
          response.writeHead(503, { "content-type": "application/json; charset=utf-8" });
          response.end(JSON.stringify({ error: "runtime_logs_unavailable" }));
          return;
        }
        try {
          const signal = AbortSignal.timeout(5_000);
          const managed = await access.runtimeManager.listManagedRuntimes(signal);
          const runtime = managed.find(
            (candidate) =>
              candidate.identity.organizationId === organizationId &&
              candidate.identity.deploymentId === deploymentId,
          );
          if (runtime === undefined) {
            response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
            response.end(JSON.stringify({ error: "runtime_not_found" }));
            return;
          }
          const logs = await access.runtimeManager.readLogs({
            containerId: runtime.containerId,
            identity: runtime.identity,
            signal,
            tail,
          });
          if (Buffer.byteLength(logs, "utf8") > 262_144)
            throw new Error("runtime log output exceeded bound");
          response.writeHead(200, {
            "cache-control": "no-store",
            "content-type": "application/json; charset=utf-8",
          });
          response.end(JSON.stringify({ logs }));
        } catch {
          if (!response.headersSent) {
            response.writeHead(503, { "content-type": "application/json; charset=utf-8" });
            response.end(JSON.stringify({ error: "runtime_logs_unavailable" }));
          } else {
            response.destroy();
          }
        }
      })();
      return;
    }
    if (request.method !== "GET" || request.url !== "/health") {
      if (request.method === "GET" && request.url === "/ready") {
        const ready = readinessCheck();
        metrics?.increment("launchrail_readiness_checks_total", {
          service: "worker",
          outcome: ready ? "ready" : "not_ready",
        });
        response.writeHead(ready ? 200 : 503, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        });
        response.end(JSON.stringify({ ready }));
        return;
      }
      response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "not_found" }));
      return;
    }

    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(createHealthResponse({ now, service: "worker", version })));
  }) as WorkerHealthServer;
  server.configureRuntimeLogs = (access) => {
    runtimeLogAccess = access;
  };
  server.configureReadiness = (check) => {
    readinessCheck = check;
  };
  return server;
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
