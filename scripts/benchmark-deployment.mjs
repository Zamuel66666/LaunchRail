#!/usr/bin/env node

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
if (
  !["127.0.0.1", "localhost", "::1"].includes(api.hostname) ||
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
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 60_000 || timeoutMs > 1_800_000)
  throw new RangeError("Benchmark timeout must be between 60,000 and 1,800,000 ms");
if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 250 || pollIntervalMs > 10_000)
  throw new RangeError("Poll interval must be between 250 and 10,000 ms");

const apiBase = api.origin;
const cookieHeaders = {
  accept: "application/json",
  cookie: sessionCookie,
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
const createdAtClock = performance.now();
const wallStart = new Date().toISOString();
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
const listPath = `/v1/organizations/${organizationId}/projects/${projectId}/deployments?limit=200`;
const deadline = Date.now() + timeoutMs;
let finalState = "queued";
let deploymentDurationMs = null;
while (Date.now() < deadline) {
  const history = await request(listPath);
  if (!Array.isArray(history?.deployments))
    throw new Error("LaunchRail API returned an invalid deployment history");
  const deployment = history.deployments.find((item) => item?.deploymentId === deploymentId);
  if (deployment !== undefined) {
    finalState = deployment.state;
    if (
      [
        "active",
        "build_failed",
        "deployment_failed",
        "cancelled",
        "rolled_back",
        "stopped",
        "superseded",
      ].includes(finalState)
    ) {
      deploymentDurationMs = performance.now() - createdAtClock;
      break;
    }
  }
  await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
}

const timedOut = deploymentDurationMs === null;
const outcome = finalState === "active" ? "active" : timedOut ? "timeout" : "failed";
const report = {
  schemaVersion: 1,
  scenario: "deployment-to-healthy-release",
  startedAt: wallStart,
  apiOrigin: api.origin,
  projectId,
  sourceRevision,
  deploymentId,
  outcome,
  finalState: timedOut ? "in_progress_at_timeout" : finalState,
  elapsedMs: Number(
    (timedOut ? performance.now() - createdAtClock : deploymentDurationMs).toFixed(1),
  ),
  timeoutMs,
  pollIntervalMs,
  node: process.version,
  platform: process.platform,
  architecture: process.arch,
  sideEffects: [
    "Creates a durable deployment and build/runtime resources.",
    "A successful candidate may become active and replace the project's previous active release.",
    "The script does not cancel, stop, or delete the created deployment or resources.",
  ],
  limitations: [
    "Run only against a dedicated local demo project and an exact commit selected for benchmarking.",
    "This single run includes queue wait, source preparation, build/cache, runtime start, health grace, and promotion; it does not isolate stage durations.",
    "Record the LaunchRail commit, cache state, machine/service versions, and host load separately.",
    "The session cookie is never included in output; protect the shell environment and stdout artifact.",
  ],
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (outcome !== "active") process.exitCode = 1;
