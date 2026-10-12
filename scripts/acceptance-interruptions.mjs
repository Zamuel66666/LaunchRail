import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { closeSync, mkdirSync, mkdtempSync, openSync } from "node:fs";
import { createServer } from "node:net";
import { request as httpRequest } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { benchmarkEnvironment } from "./benchmark-environment.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const required = (name) => {
  if (!process.env[name]) throw new Error(`${name} is required`);
  return process.env[name];
};
const checks = [];
const services = new Map();
const stoppedContainers = new Set();
let cookie;
let project;
let organizationId;
let logDirectory;
let config;

function configuration() {
  if (process.env.LAUNCHRAIL_ACCEPTANCE_ALLOW_MUTATION !== "DEDICATED_LOCAL_ACCEPTANCE")
    throw new Error("Dedicated local acceptance acknowledgement is required");
  const database = new URL(required("DATABASE_URL"));
  if (
    !["postgres:", "postgresql:"].includes(database.protocol) ||
    !["127.0.0.1", "localhost"].includes(database.hostname) ||
    !/^\/launchrail_[a-z0-9_]*(acceptance|release)[a-z0-9_]*$/u.test(database.pathname)
  )
    throw new Error("A dedicated loopback acceptance database is required");
  const revision = required("LAUNCHRAIL_ACCEPTANCE_SOURCE_REVISION");
  if (!/^[0-9a-f]{40}$/u.test(revision)) throw new Error("A full source revision is required");
  const email = required("LAUNCHRAIL_BOOTSTRAP_EMAIL");
  if (!email.endsWith("@launchrail.test"))
    throw new Error("A synthetic acceptance owner is required");
  const password = required("LAUNCHRAIL_BOOTSTRAP_PASSWORD");
  const apiPort = Number(required("API_PORT"));
  const workerPort = Number(required("WORKER_HEALTH_PORT"));
  const proxyPort = Number(process.env.TRAEFIK_PORT ?? 8080);
  for (const port of [apiPort, workerPort, proxyPort])
    if (!Number.isSafeInteger(port) || port < 1024 || port > 65535)
      throw new Error("Invalid acceptance port");
  const origin = new URL(required("WEB_ORIGIN"));
  if (
    !["localhost", "127.0.0.1"].includes(origin.hostname) ||
    origin.protocol !== "http:" ||
    origin.href !== `${origin.origin}/`
  )
    throw new Error("A loopback browser origin is required");
  if (process.env.API_HOST !== "127.0.0.1" || process.env.WORKER_HEALTH_HOST !== "127.0.0.1")
    throw new Error("Loopback application bindings are required");
  return {
    apiPort,
    workerPort,
    proxyPort,
    origin: origin.origin,
    email,
    password,
    revision,
    database: database.pathname.slice(1),
  };
}

async function until(label, check, timeoutMs = 180_000) {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    const value = await check();
    if (value) {
      checks.push({
        check: label,
        durationMs: Math.round((performance.now() - started) * 10) / 10,
      });
      process.stderr.write(`${label}: passed\n`);
      return value;
    }
    await sleep(100);
  }
  throw new Error(`Acceptance deadline exceeded: ${label}`);
}
const docker = (args) =>
  execFileSync("docker", args, {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 1_048_576,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
function managedContainers() {
  const ids = docker([
    "ps",
    "--all",
    "--filter",
    "label=dev.launchrail.managed=true",
    "--format",
    "{{.ID}}",
  ]);
  return ids ? JSON.parse(docker(["inspect", ...ids.split("\n")])) : [];
}
function faultContainer(service) {
  const id = docker(["compose", "ps", "--all", "--quiet", service]);
  if (!/^[0-9a-f]{64}$/u.test(id)) throw new Error("Expected one Compose service container");
  const [container] = JSON.parse(docker(["inspect", id]));
  if (
    container.Config.Labels?.["com.docker.compose.project"] !== "launchrail" ||
    container.Config.Labels?.["com.docker.compose.service"] !== service ||
    !container.State.Running
  )
    throw new Error("Compose fault target ownership is invalid");
  return id;
}
function stopContainer(id) {
  stoppedContainers.add(id);
  docker(["stop", "--time", "10", id]);
}
function restoreContainer(id) {
  docker(["start", id]);
  stoppedContainers.delete(id);
}
async function assertFree(port) {
  const server = createServer();
  server.listen(port, "127.0.0.1");
  try {
    await once(server, "listening");
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
}
function startProcess(service) {
  if (services.has(service)) throw new Error("Service process already exists");
  const fd = openSync(join(logDirectory, `${service}-${randomUUID()}.log`), "wx", 0o600);
  const child = spawn(process.execPath, [`apps/${service}/dist/index.js`], {
    cwd: root,
    env: process.env,
    stdio: ["ignore", fd, fd],
  });
  closeSync(fd);
  services.set(service, child);
  return child;
}
async function stopProcess(service, signal = "SIGTERM") {
  const child = services.get(service);
  if (!child) return;
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill(signal);
    let timer;
    try {
      await Promise.race([
        exited,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("Owned service failed to stop")), 40_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  services.delete(service);
}
async function readiness(service, expected) {
  const port = service === "api" ? config.apiPort : config.workerPort;
  return until(
    `${service}-readiness-${expected}`,
    async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/ready`, {
          signal: AbortSignal.timeout(5_000),
        });
        return expected ? r.status === 200 : r.status === 503;
      } catch {
        return false;
      }
    },
    60_000,
  );
}
async function request(path, options = {}) {
  const r = await fetch(`http://localhost:${config.apiPort}${path}`, {
    ...options,
    headers: {
      cookie: cookie ?? "",
      origin: config.origin,
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...options.headers,
    },
    signal: AbortSignal.timeout(15_000),
    redirect: "error",
  });
  if (!r.ok) throw new Error(`Acceptance HTTP request failed with status ${r.status}`);
  return r.status === 204 ? undefined : r.json();
}
function base() {
  return `/v1/organizations/${organizationId}`;
}
async function history() {
  return (await request(`${base()}/projects/${project.id}/deployments?limit=200`)).deployments;
}
async function deploymentState(id, expected) {
  return until(`deployment-${expected}`, async () => {
    const row = (await history()).find((x) => x.deploymentId === id);
    if (row?.state === expected) return row;
    if (row && ["deployment_failed", "build_failed", "cancelled"].includes(row.state))
      throw new Error("Deployment reached unexpected terminal failure");
    return false;
  });
}
async function deploy() {
  const r = await request(`${base()}/deployments`, {
    method: "POST",
    body: JSON.stringify({ projectId: project.id, sourceRevision: config.revision }),
  });
  if (!uuid.test(r.deployment?.deploymentId ?? ""))
    throw new Error("Invalid accepted deployment identity");
  return r.deployment.deploymentId;
}
async function setDockerfile(path) {
  const r = await request(`${base()}/projects/${project.id}`, {
    method: "PATCH",
    body: JSON.stringify({ expectedVersion: project.version, dockerfilePath: path }),
  });
  project = r.project;
}
async function preview(id, expected = 200) {
  return until(
    `preview-${expected}`,
    () =>
      new Promise((resolve) => {
        const r = httpRequest(
          { hostname: "127.0.0.1", port: config.proxyPort, headers: { host: `d-${id}.localhost` } },
          (response) => {
            let body = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => {
              body += chunk;
            });
            response.on("end", () =>
              resolve(
                response.statusCode === expected &&
                  (expected !== 200 || body.includes("LaunchRail")),
              ),
            );
          },
        );
        r.setTimeout(2_000, () => r.destroy());
        r.on("error", () => resolve(expected === 0));
        r.end();
      }),
    30_000,
  );
}
async function verifyActivation(id) {
  await deploymentState(id, "active");
  await preview(id);
  const events = (await request(`${base()}/deployments/${id}/events`)).events;
  if (
    events.filter((e) => e.toState === "active").length !== 1 ||
    new Set(events.map((e) => e.sequence)).size !== events.length
  )
    throw new Error("Activation/event uniqueness failed");
  checks.push({ check: "unique-activation-event", deploymentId: id });
}
async function cleanupProject() {
  if (!project || !cookie || !services.has("api")) return;
  for (const row of await history()) {
    if (["active", "superseded"].includes(row.state))
      await request(`${base()}/deployments/${row.deploymentId}/stop`, {
        method: "POST",
        headers: { "idempotency-key": `interruption-cleanup-${row.deploymentId}` },
      });
    else if (
      !["stopped", "cancelled", "build_failed", "deployment_failed", "rolled_back"].includes(
        row.state,
      )
    ) {
      await request(`${base()}/deployments/${row.deploymentId}/cancel`, {
        method: "POST",
        headers: { "idempotency-key": `interruption-cleanup-${row.deploymentId}` },
      });
    }
  }
  if (!services.has("worker")) {
    startProcess("worker");
    await readiness("worker", true);
  }
  await until("project-runtime-inventory-converged", () => {
    const all = managedContainers();
    for (const c of all) {
      const labels = c.Config.Labels;
      if (
        labels?.["dev.launchrail.organization-id"] !== organizationId ||
        labels?.["dev.launchrail.project-id"] !== project.id
      )
        throw new Error("Unexpected managed container appeared in dedicated acceptance");
    }
    return all.length === 0;
  });
}

try {
  config = configuration();
  const environment = await benchmarkEnvironment();
  if (!environment.workingTreeClean)
    throw new Error("Clean committed source is required for interruption acceptance");
  if (managedContainers().length !== 0)
    throw new Error("Dedicated Docker inventory must be empty before acceptance");
  await assertFree(config.apiPort);
  await assertFree(config.workerPort);
  const containers = Object.fromEntries(
    ["redis", "postgres", "traefik"].map((service) => [service, faultContainer(service)]),
  );
  mkdirSync(join(root, "output"), { recursive: true });
  logDirectory = mkdtempSync(join(root, "output", "interruptions-"));
  startProcess("api");
  await readiness("api", true);
  const signedIn = await fetch(`http://localhost:${config.apiPort}/v1/auth/sign-in`, {
    method: "POST",
    headers: { origin: config.origin, "content-type": "application/json" },
    body: JSON.stringify({ email: config.email, password: config.password }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!signedIn.ok) throw new Error("Synthetic owner sign-in failed");
  cookie = signedIn.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Synthetic session was not issued");
  const principal = await signedIn.json();
  organizationId = principal.user?.memberships?.[0]?.organizationId;
  if (!uuid.test(organizationId ?? "")) throw new Error("Synthetic organization identity missing");
  project = (
    await request(`${base()}/projects`, {
      method: "POST",
      body: JSON.stringify({
        name: `Interruption acceptance ${randomUUID().slice(0, 8)}`,
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
    })
  ).project;

  const apiIntent = await deploy();
  await deploymentState(apiIntent, "queued");
  await stopProcess("api", "SIGKILL");
  startProcess("api");
  await readiness("api", true);
  await deploymentState(apiIntent, "queued");
  startProcess("worker");
  await readiness("worker", true);
  await verifyActivation(apiIntent);
  checks.push({ check: "api-abrupt-exit-preserved-accepted-intent", deploymentId: apiIntent });

  await setDockerfile("examples/apps/slow-build/Dockerfile");
  const interrupted = await deploy();
  await until("build-step-observed-before-worker-kill", async () => {
    const logs = (await request(`${base()}/deployments/${interrupted}/build-logs?limit=500`)).logs;
    const row = (await history()).find((x) => x.deploymentId === interrupted);
    return (
      row?.state === "building" &&
      logs?.some((x) => x.content.includes("RUN sleep 10") && !x.content.includes("CACHED"))
    );
  });
  await sleep(500);
  const buildProof = (
    await request(`${base()}/deployments/${interrupted}/build-logs?limit=500`)
  ).logs
    .map((x) => x.content)
    .join("");
  const step = buildProof.match(/^#(\d+) \[[^\]]+\] RUN sleep 10$/mu)?.[1];
  if (
    !step ||
    new RegExp(`^#${step} (CACHED|DONE)`, "mu").test(buildProof) ||
    !(await history()).some((x) => x.deploymentId === interrupted && x.state === "building")
  )
    throw new Error(
      "An observed uncached in-progress sleep build step is required; use a fresh dedicated builder cache",
    );
  checks.push({
    check: "uncached-build-step-still-running-at-worker-fault",
    deploymentId: interrupted,
  });
  await stopProcess("worker", "SIGKILL");
  startProcess("worker");
  await readiness("worker", true);
  await verifyActivation(interrupted);
  checks.push({
    check: "worker-abrupt-exit-during-observed-build-recovered",
    deploymentId: interrupted,
  });
  await setDockerfile("examples/apps/healthy/Dockerfile");

  stopContainer(containers.redis);
  await readiness("worker", false);
  const redisIntent = await deploy();
  await deploymentState(redisIntent, "queued");
  await preview(interrupted);
  restoreContainer(containers.redis);
  await readiness("worker", true);
  await verifyActivation(redisIntent);
  checks.push({
    check: "redis-outage-preserved-accepted-intent-and-prior-preview",
    deploymentId: redisIntent,
  });

  stopContainer(containers.postgres);
  await readiness("api", false);
  await readiness("worker", false);
  await preview(redisIntent);
  restoreContainer(containers.postgres);
  await readiness("api", true);
  await readiness("worker", true);
  const databaseIntent = await deploy();
  await verifyActivation(databaseIntent);
  checks.push({
    check: "postgres-outage-fenced-readiness-and-recovered-new-work",
    deploymentId: databaseIntent,
  });

  stopContainer(containers.traefik);
  await preview(databaseIntent, 0);
  await deploymentState(databaseIntent, "active");
  restoreContainer(containers.traefik);
  await preview(databaseIntent);
  await deploymentState(databaseIntent, "active");
  checks.push({
    check: "proxy-outage-preserved-active-authority-and-restored-exact-route",
    deploymentId: databaseIntent,
  });
  await cleanupProject();
  const report = {
    schemaVersion: 1,
    scenario: "physical-single-host-interruption-acceptance",
    environment,
    sourceRevision: config.revision,
    database: config.database,
    organizationId,
    projectId: project.id,
    profile: {
      workerLeaseMs: Number(process.env.WORKER_LEASE_MS),
      workerHeartbeatMs: Number(process.env.WORKER_HEARTBEAT_INTERVAL_MS),
      workerReconciliationMs: Number(process.env.WORKER_RECONCILIATION_INTERVAL_MS),
    },
    checks,
    limitations: [
      "One documented boundary per component, not every possible crash point or simultaneous outage",
      "Worker fault is injected after an observed uncached sleep build step; physical Docker-daemon loss is not injected",
      "Local Compose service stops preserve volumes; cleanup removes only scenario runtimes through durable control/reconciliation",
      "Unrelated services and original acceptance database are not deleted or reinitialized",
    ],
  };
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Interruption acceptance failed"}\n`,
  );
  process.exitCode = 1;
} finally {
  for (const id of stoppedContainers) {
    try {
      restoreContainer(id);
    } catch {
      process.stderr.write("A scoped Compose service needs operator restart\n");
      process.exitCode = 1;
    }
  }
  for (const service of ["worker", "api"]) {
    try {
      await stopProcess(service);
    } catch {
      process.stderr.write("An owned acceptance process needs operator shutdown\n");
      process.exitCode = 1;
    }
  }
}
