#!/usr/bin/env node

import { benchmarkEnvironment } from "./benchmark-environment.mjs";

const required = [
  "LAUNCHRAIL_BENCHMARK_API_URL",
  "LAUNCHRAIL_BENCHMARK_ORGANIZATION_ID",
  "LAUNCHRAIL_BENCHMARK_PROJECT_ID",
  "LAUNCHRAIL_BENCHMARK_SOURCE_REVISION",
  "LAUNCHRAIL_BENCHMARK_SESSION_COOKIE",
];
for (const name of required) {
  if (!process.env[name]) throw new Error(`${name} is required`);
}
if (
  process.env.LAUNCHRAIL_BENCHMARK_ALLOW_RELEASE_MUTATION !==
  "I_UNDERSTAND_THIS_CREATES_A_DEPLOYMENT"
) {
  throw new Error(
    "Set LAUNCHRAIL_BENCHMARK_ALLOW_RELEASE_MUTATION to the exact confirmation value; this scenario creates and may activate a real deployment",
  );
}

const api = new URL(process.env.LAUNCHRAIL_BENCHMARK_API_URL);
const apiHostname = api.hostname.replace(/^\[|\]$/gu, "");
if (
  !["127.0.0.1", "localhost", "::1"].includes(apiHostname) ||
  !["http:", "https:"].includes(api.protocol) ||
  api.username !== "" ||
  api.password !== "" ||
  api.pathname !== "/" ||
  api.search !== "" ||
  api.hash !== ""
) {
  throw new Error("Benchmark API must be a loopback HTTP(S) URL without credentials or query data");
}
const organizationId = process.env.LAUNCHRAIL_BENCHMARK_ORGANIZATION_ID;
const projectId = process.env.LAUNCHRAIL_BENCHMARK_PROJECT_ID;
const sourceRevision = process.env.LAUNCHRAIL_BENCHMARK_SOURCE_REVISION;
const sessionCookie = process.env.LAUNCHRAIL_BENCHMARK_SESSION_COOKIE;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
if (!uuid.test(organizationId) || !uuid.test(projectId))
  throw new Error("Organization and project IDs must be UUIDs");
if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/u.test(sourceRevision))
  throw new Error("Source revision must be a full lowercase Git commit SHA");
if (!/^launchrail_session=[A-Za-z0-9_-]{43}$/u.test(sessionCookie)) {
  throw new Error("Session cookie must be one default-format launchrail_session token");
}

const timeoutMs = Number(process.env.LAUNCHRAIL_BENCHMARK_TIMEOUT_MS ?? 900_000);
const pollIntervalMs = Number(process.env.LAUNCHRAIL_BENCHMARK_POLL_INTERVAL_MS ?? 1_000);
const runCount = Number(process.env.LAUNCHRAIL_BENCHMARK_RUNS ?? 1);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 60_000 || timeoutMs > 1_800_000)
  throw new RangeError("Benchmark timeout must be between 60,000 and 1,800,000 ms");
if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 250 || pollIntervalMs > 10_000)
  throw new RangeError("Poll interval must be between 250 and 10,000 ms");
if (!Number.isSafeInteger(runCount) || runCount < 1 || runCount > 10)
  throw new RangeError("Benchmark run count must be between 1 and 10");

const apiBase = api.origin;
const webOrigin = new URL(process.env.WEB_ORIGIN ?? "http://localhost:3000");
if (
  !["http:", "https:"].includes(webOrigin.protocol) ||
  webOrigin.username !== "" ||
  webOrigin.password !== "" ||
  webOrigin.pathname !== "/" ||
  webOrigin.search !== "" ||
  webOrigin.hash !== ""
)
  throw new Error("WEB_ORIGIN must be an HTTP(S) origin without credentials or path data");
const cookieHeaders = {
  accept: "application/json",
  cookie: sessionCookie,
  origin: webOrigin.origin,
};

async function request(path, options = {}) {
  const response = await fetch(new URL(path, apiBase), {
    ...options,
    headers: { ...cookieHeaders, ...options.headers },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`LaunchRail API returned a non-JSON response (${response.status})`);
  }
  if (!response.ok) throw new Error(`LaunchRail API request failed (${response.status})`);
  return body;
}

const deploymentPath = `/v1/organizations/${organizationId}/deployments`;
const wallStart = new Date().toISOString();
const listPath = `/v1/organizations/${organizationId}/projects/${projectId}/deployments?limit=200`;
const terminalStates = new Set([
  "active",
  "build_failed",
  "deployment_failed",
  "cancelled",
  "rolled_back",
  "stopped",
  "superseded",
]);

async function measureDeployment(runNumber) {
  const startedAtClock = performance.now();
  const created = await request(deploymentPath, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId, sourceRevision }),
  });
  if (
    typeof created !== "object" ||
    created === null ||
    typeof created.deployment !== "object" ||
    created.deployment === null ||
    typeof created.deployment.deploymentId !== "string" ||
    !uuid.test(created.deployment.deploymentId)
  ) {
    throw new Error("LaunchRail API did not return a valid deployment identity");
  }
  const deploymentId = created.deployment.deploymentId;
  const eventsPath = `/v1/organizations/${organizationId}/deployments/${deploymentId}/events?limit=200`;
  const deadline = Date.now() + timeoutMs;
  let finalState = "queued";
  let deploymentCreatedAt;
  let completed = false;
  while (Date.now() < deadline) {
    const history = await request(listPath);
    if (!Array.isArray(history?.deployments))
      throw new Error("LaunchRail API returned an invalid deployment history");
    const deployment = history.deployments.find((item) => item?.deploymentId === deploymentId);
    if (deployment !== undefined) {
      finalState = deployment.state;
      if (typeof deployment.createdAt === "string") deploymentCreatedAt = deployment.createdAt;
      if (terminalStates.has(finalState)) {
        completed = true;
        break;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  let stageDurationsMs = null;
  let stageTimingStatus = "unavailable";
  try {
    const eventHistory = await request(eventsPath);
    const events = eventHistory?.events;
    if (
      Array.isArray(events) &&
      typeof deploymentCreatedAt === "string" &&
      Number.isFinite(Date.parse(deploymentCreatedAt))
    ) {
      const states = new Map();
      for (const event of [...events].sort(
        (left, right) => Number(left?.sequence) - Number(right?.sequence),
      )) {
        if (
          typeof event?.sequence !== "number" ||
          typeof event.toState !== "string" ||
          typeof event.createdAt !== "string"
        )
          continue;
        const timestamp = Date.parse(event.createdAt);
        if (Number.isFinite(timestamp) && !states.has(event.toState))
          states.set(event.toState, timestamp);
      }
      const duration = (from, to, fallbackStart) => {
        const start = states.get(from) ?? fallbackStart;
        const end = states.get(to);
        if (typeof start !== "number" || !Number.isFinite(start) || end === undefined) return null;
        const elapsed = end - start;
        return elapsed < 0 ? null : Number(elapsed.toFixed(1));
      };
      const createdAt = Date.parse(deploymentCreatedAt);
      stageDurationsMs = {
        queueWait: duration("queued", "cloning", createdAt),
        sourcePreparation: duration("cloning", "building"),
        imageBuild: duration("building", "deploying"),
        runtimeStart: duration("deploying", "health_checking"),
        healthAndPromotion: duration("health_checking", "active"),
      };
      stageTimingStatus = Object.values(stageDurationsMs).every((value) => value !== null)
        ? "available"
        : "partial";
    }
  } catch {
    // Stage diagnostics are best-effort and must not hide the deployment's authoritative outcome.
  }
  const outcome = finalState === "active" ? "active" : completed ? "failed" : "timeout";
  return {
    runNumber,
    deploymentId,
    outcome,
    finalState: completed ? finalState : "in_progress_at_timeout",
    elapsedMs: Number((performance.now() - startedAtClock).toFixed(1)),
    stageTimingStatus,
    stageDurationsMs,
  };
}

const runs = [];
for (let runNumber = 1; runNumber <= runCount; runNumber += 1) {
  runs.push(await measureDeployment(runNumber));
}

function summary(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length === 0) return { samples: 0, medianMs: null, p95Ms: null };
  const percentile = (fraction) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
  return {
    samples: sorted.length,
    medianMs: Number(percentile(0.5).toFixed(1)),
    p95Ms: Number(percentile(0.95).toFixed(1)),
  };
}

const stageNames = [
  "queueWait",
  "sourcePreparation",
  "imageBuild",
  "runtimeStart",
  "healthAndPromotion",
];
const stageSummaryMs = Object.fromEntries(
  stageNames.map((stage) => [stage, summary(runs.map((run) => run.stageDurationsMs?.[stage]))]),
);
const outcomes = Object.fromEntries(
  ["active", "failed", "timeout"].map((outcome) => [
    outcome,
    runs.filter((run) => run.outcome === outcome).length,
  ]),
);
const report = {
  schemaVersion: 1,
  scenario: "deployment-to-healthy-release",
  startedAt: wallStart,
  apiOrigin: api.origin,
  projectId,
  sourceRevision,
  requestedRuns: runCount,
  outcomes,
  runs,
  stageSummaryMs,
  timeoutMs,
  pollIntervalMs,
  node: process.version,
  platform: process.platform,
  architecture: process.arch,
  environment: benchmarkEnvironment(),
  sideEffects: [
    `Creates ${runCount} durable deployment(s) and associated build/runtime resources.`,
    "Each successful candidate may become active and replace the project's current active release.",
    "The script does not cancel, stop, or delete created deployments or resources.",
  ],
  limitations: [
    "Run only against a dedicated local demo project and an exact commit selected for benchmarking.",
    "Sequential runs may have different cache state and replace the active release; record those conditions explicitly.",
    "Stage intervals derive from persisted lifecycle timestamps, not isolated resource timers, and do not include host resource telemetry.",
    "Record the LaunchRail commit, cache state, machine/service versions, and host load separately.",
    "The session cookie is never included in output; protect the shell environment and stdout artifact.",
  ],
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (outcomes.failed > 0 || outcomes.timeout > 0) process.exitCode = 1;
