import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { promisify } from "node:util";

import { expect, it } from "vitest";

const execute = promisify(execFile);

it("checks health preservation, promotion, rollback, cancellation and stop against bounded HTTP fixtures", async () => {
  const cookie = `launchrail_session=${"a".repeat(43)}`;
  const organizationId = randomUUID();
  let project: Record<string, unknown>;
  const deployments: { deploymentId: string; state: string; failureCategory?: string }[] = [];
  const controls: string[] = [];
  const api = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.headers.cookie !== cookie || request.headers.origin !== "http://localhost:3100") {
      response.writeHead(403).end("{}");
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    if (body.length === 0 && request.headers["content-type"] === "application/json") {
      response.writeHead(400).end("{}");
      return;
    }
    if (request.method === "POST" && request.url?.endsWith("/projects")) {
      project = { ...JSON.parse(body), id: randomUUID(), version: 1 };
      response.end(JSON.stringify({ project }));
    } else if (request.method === "PATCH") {
      const input = JSON.parse(body);
      expect(input.expectedVersion).toBe(project.version);
      project = { ...project, ...input, version: Number(project.version) + 1 };
      response.end(JSON.stringify({ project }));
    } else if (request.method === "POST" && request.url?.endsWith("/deployments")) {
      const failed = project.healthCheckPath === "/missing-health";
      if (!failed && deployments.length < 3)
        for (const previous of deployments)
          if (previous.state === "active") previous.state = "superseded";
      const deployment = {
        deploymentId: randomUUID(),
        state: failed ? "deployment_failed" : deployments.length === 3 ? "queued" : "active",
        ...(failed ? { failureCategory: "health_unhealthy" } : {}),
      };
      deployments.push(deployment);
      response.end(JSON.stringify({ deployment }));
    } else if (request.method === "POST") {
      const parts = request.url?.split("/") ?? [];
      const action = parts.at(-1)!;
      const deployment = deployments.find((item) => item.deploymentId === parts.at(-2))!;
      controls.push(action);
      expect(request.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/u);
      if (action === "rollback") {
        deployment.state = "rolled_back";
        deployments[0]!.state = "active";
      } else deployment.state = action === "cancel" ? "cancelled" : "stopped";
      response.end("{}");
    } else response.end(JSON.stringify({ deployments }));
  });
  const proxy = createServer((request, response) => {
    const deployment = deployments.find(
      (item) => request.headers.host === `d-${item.deploymentId}.localhost`,
    );
    response.writeHead(deployment?.state === "active" ? 200 : 404);
    response.end(deployment?.state === "active" ? "LaunchRail deployment is healthy" : "Not found");
  });
  api.listen(0, "127.0.0.1");
  proxy.listen(0, "127.0.0.1");
  await Promise.all([once(api, "listening"), once(proxy, "listening")]);
  const apiAddress = api.address();
  const proxyAddress = proxy.address();
  if (
    !apiAddress ||
    typeof apiAddress === "string" ||
    !proxyAddress ||
    typeof proxyAddress === "string"
  )
    throw new Error("Missing fixture ports");
  try {
    const output = await execute(process.execPath, ["scripts/acceptance-lifecycle.mjs"], {
      env: {
        ...process.env,
        WEB_ORIGIN: "http://localhost:3100",
        LAUNCHRAIL_ACCEPTANCE_ALLOW_MUTATION: "DEDICATED_LOCAL_ACCEPTANCE",
        LAUNCHRAIL_ACCEPTANCE_API_URL: `http://127.0.0.1:${apiAddress.port}`,
        LAUNCHRAIL_ACCEPTANCE_ORGANIZATION_ID: organizationId,
        LAUNCHRAIL_ACCEPTANCE_SOURCE_REVISION: "a".repeat(40),
        LAUNCHRAIL_ACCEPTANCE_SESSION_COOKIE: cookie,
        LAUNCHRAIL_ACCEPTANCE_TIMEOUT_MS: "1000",
        TRAEFIK_PORT: String(proxyAddress.port),
      },
    }).catch((error) => {
      throw new Error(error.stdout || error.message);
    });
    const report = JSON.parse(output.stdout);
    expect(report.outcome).toBe("passed");
    expect(report.evidence).toHaveLength(17);
    expect(controls).toEqual(["rollback", "cancel", "stop"]);
    expect(deployments.map((item) => item.state)).toEqual([
      "stopped",
      "deployment_failed",
      "rolled_back",
      "cancelled",
    ]);
    expect(output.stdout).not.toContain(cookie);
  } finally {
    await Promise.all(
      [api, proxy].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  }
});
