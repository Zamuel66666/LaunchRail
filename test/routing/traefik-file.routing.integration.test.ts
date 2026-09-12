import { createServer, request as httpRequest } from "node:http";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TraefikFileRouteManager } from "../../packages/routing/dist/index.js";

const deploymentId = "11111111-1111-4111-8111-111111111111";
const hostname = `d-${deploymentId}.localhost`;
const configurationDirectory = resolve(
  process.env.TRAEFIK_DYNAMIC_CONFIG_DIR ?? ".launchrail/traefik",
);
const proxyPort = Number(process.env.TRAEFIK_PORT ?? "8080");

function request(host: string): Promise<{ readonly body: string; readonly statusCode: number }> {
  return new Promise((resolveRequest, reject) => {
    const request_ = httpRequest(
      { headers: { host }, hostname: "127.0.0.1", port: proxyPort },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => resolveRequest({ body, statusCode: response.statusCode ?? 0 }));
      },
    );
    request_.once("error", reject);
    request_.end();
  });
}

describe("Traefik file-provider routing", () => {
  const manager = new TraefikFileRouteManager({ configurationDirectory });
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("launchrail-routing-fixture");
  });
  let hostPort = 0;

  beforeAll(async () => {
    await mkdir(configurationDirectory, { recursive: true, mode: 0o700 });
    await new Promise<void>((resolveListen) => server.listen(0, "0.0.0.0", resolveListen));
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("Fixture server did not receive a TCP port");
    hostPort = address.port;
  });

  afterAll(async () => {
    await manager.remove({ deploymentId, hostname });
    await new Promise<void>((resolveClose, reject) =>
      server.close((error) => (error === undefined ? resolveClose() : reject(error))),
    );
  });

  it("applies a localhost route and Traefik reaches only its loopback-published host port", async () => {
    await manager.apply({ deploymentId, hostname }, { hostPort });
    let result: { readonly body: string; readonly statusCode: number } | undefined;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        const candidate = await request(hostname);
        if (candidate.statusCode === 200) {
          result = candidate;
          break;
        }
      } catch {
        // File-provider watches are asynchronous; retry only within this bounded acceptance window.
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    expect(result).toEqual({ body: "launchrail-routing-fixture", statusCode: 200 });
    await manager.remove({ deploymentId, hostname });
    await expect(request(hostname)).resolves.toMatchObject({ statusCode: 404 });
  });
});
