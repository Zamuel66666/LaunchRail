import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { benchmarkEnvironment } from "./benchmark-environment.mjs";

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
if (process.env.LAUNCHRAIL_ACCEPTANCE_ALLOW_MUTATION !== "DEDICATED_LOCAL_ACCEPTANCE")
  throw new Error("Set LAUNCHRAIL_ACCEPTANCE_ALLOW_MUTATION=DEDICATED_LOCAL_ACCEPTANCE");
const api = new URL(required("LAUNCHRAIL_ACCEPTANCE_API_URL"));
if (
  !["localhost", "127.0.0.1", "[::1]"].includes(api.hostname) ||
  api.protocol !== "http:" ||
  api.pathname !== "/" ||
  api.search ||
  api.hash ||
  api.username ||
  api.password
)
  throw new Error("Acceptance requires a credential-free loopback HTTP origin");
const origin = new URL(required("WEB_ORIGIN"));
if (origin.origin !== origin.href.slice(0, -1)) throw new Error("WEB_ORIGIN must be an origin");
const organizationId = required("LAUNCHRAIL_ACCEPTANCE_ORGANIZATION_ID");
const revision = required("LAUNCHRAIL_ACCEPTANCE_SOURCE_REVISION");
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
if (!uuid.test(organizationId) || !/^[0-9a-f]{40}$/u.test(revision))
  throw new Error("Acceptance requires an organization UUID and full commit SHA");
const cookie = required("LAUNCHRAIL_ACCEPTANCE_SESSION_COOKIE");
if (!/^launchrail_session=[A-Za-z0-9_-]{43}$/u.test(cookie))
  throw new Error("Invalid session cookie format");
const proxyPort = Number(process.env.TRAEFIK_PORT ?? 8080);
if (!Number.isSafeInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535)
  throw new Error("Invalid preview port");
const timeoutMs = Number(process.env.LAUNCHRAIL_ACCEPTANCE_TIMEOUT_MS ?? 300000);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 1800000)
  throw new Error("Invalid acceptance timeout");
const base = `/v1/organizations/${organizationId}`;
const startedAt = new Date().toISOString();
const evidence = [];
let project;

async function request(path, options = {}) {
  const response = await fetch(new URL(path, api), {
    ...options,
    headers: {
      cookie,
      origin: origin.origin,
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Acceptance API request failed (${response.status})`);
  if (response.status === 204) return undefined;
  return response.json();
}
const pause = () => new Promise((resolve) => setTimeout(resolve, 250));
async function until(label, check) {
  const started = performance.now();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) {
      evidence.push({ check: label, durationMs: performance.now() - started });
      return value;
    }
    await pause();
  }
  throw new Error(`Acceptance deadline exceeded: ${label}`);
}
async function history() {
  return (await request(`${base}/projects/${project.id}/deployments?limit=200`)).deployments;
}
async function state(id, expected) {
  return until(`${id}:${expected}`, async () => {
    const deployment = (await history()).find((item) => item.deploymentId === id);
    if (deployment?.state === expected) return deployment;
    if (
      ["build_failed", "deployment_failed", "cancelled", "stopped", "rolled_back"].includes(
        deployment?.state,
      )
    )
      throw new Error(`Unexpected terminal state while awaiting ${expected}: ${deployment.state}`);
    return false;
  });
}
async function deploy() {
  const result = await request(`${base}/deployments`, {
    method: "POST",
    body: JSON.stringify({ projectId: project.id, sourceRevision: revision }),
  });
  if (!uuid.test(result.deployment.deploymentId)) throw new Error("Invalid deployment identity");
  return result.deployment.deploymentId;
}
async function configureHealth(path) {
  const { name, repositoryUrl, defaultBranch, dockerfilePath, healthCheckPort, runtimeConfig } =
    project;
  const { version: _version, ...runtime } = runtimeConfig;
  const updated = await request(`${base}/projects/${project.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      name,
      repositoryUrl,
      defaultBranch,
      dockerfilePath,
      healthCheckPath: path,
      healthCheckPort,
      runtimeConfig: runtime,
      expectedVersion: project.version,
    }),
  });
  project = updated.project;
}
async function preview(id, expected) {
  await until(`${id}:preview-http-${expected}`, async () => {
    try {
      const response = await new Promise((resolve, reject) => {
        const connection = httpRequest(
          { hostname: "127.0.0.1", port: proxyPort, headers: { host: `d-${id}.localhost` } },
          (incoming) => {
            let body = "";
            incoming.setEncoding("utf8");
            incoming.on("data", (chunk) => {
              body += chunk;
              if (Buffer.byteLength(body) > 65536)
                connection.destroy(new Error("Preview exceeded its response bound"));
            });
            incoming.once("error", reject);
            incoming.once("aborted", () => reject(new Error("Preview response aborted")));
            incoming.once("end", () => resolve({ status: incoming.statusCode, body }));
          },
        );
        const timer = setTimeout(
          () => connection.destroy(new Error("Preview request timed out")),
          3000,
        );
        connection.once("close", () => clearTimeout(timer));
        connection.once("error", reject);
        connection.end();
      });
      if (response.status !== expected) return false;
      if (expected === 200 && !response.body.includes("LaunchRail deployment is healthy"))
        throw new Error("Preview returned the wrong application");
      return true;
    } catch (error) {
      if (error.message === "Preview returned the wrong application") throw error;
      return false;
    }
  });
}
async function control(id, action) {
  await request(`${base}/deployments/${id}/${action}`, { method: "POST" });
}

try {
  const created = await request(`${base}/projects`, {
    method: "POST",
    body: JSON.stringify({
      name: `Lifecycle acceptance ${randomUUID().slice(0, 8)}`,
      repositoryUrl: "https://github.com/Zamuel66666/LaunchRail",
      defaultBranch: "main",
      dockerfilePath: "examples/apps/healthy/Dockerfile",
      healthCheckPath: "/",
      healthCheckPort: 3000,
      runtimeConfig: {
        cpuMillicores: 500,
        memoryMegabytes: 512,
        processLimit: 128,
        readOnlyRootFilesystem: true,
      },
    }),
  });
  project = created.project;
  const first = await deploy();
  await state(first, "active");
  await preview(first, 200);
  await configureHealth("/missing-health");
  const unhealthy = await deploy();
  const failure = await state(unhealthy, "deployment_failed");
  if (failure.failureCategory !== "health_unhealthy")
    throw new Error("Unhealthy failure was not classified");
  await state(first, "active");
  await preview(first, 200);
  await configureHealth("/");
  const second = await deploy();
  await state(second, "active");
  await state(first, "superseded");
  await preview(second, 200);
  await control(second, "rollback");
  await state(second, "rolled_back");
  await state(first, "active");
  await preview(first, 200);
  await preview(second, 404);
  const cancelled = await deploy();
  await control(cancelled, "cancel");
  await state(cancelled, "cancelled");
  await state(first, "active");
  await preview(first, 200);
  await control(first, "stop");
  await state(first, "stopped");
  await preview(first, 404);
  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        scenario: "real-deployment-control-lifecycle",
        startedAt,
        environment: benchmarkEnvironment(),
        projectId: project.id,
        sourceRevision: revision,
        deployments: { first, unhealthy, second, cancelled },
        evidence,
        outcome: "passed",
      },
      null,
      2,
    )}\n`,
  );
} catch (error) {
  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        scenario: "real-deployment-control-lifecycle",
        startedAt,
        environment: benchmarkEnvironment(),
        projectId: project?.id ?? null,
        evidence,
        outcome: "failed",
        error: error.message,
      },
      null,
      2,
    )}\n`,
  );
  process.exitCode = 1;
}
