#!/usr/bin/env node

const arguments_ = new Map(
  process.argv.slice(2).map((argument) => {
    const [name, value] = argument.split("=", 2);
    return [name.replace(/^--/u, ""), value];
  }),
);

function positiveInteger(name, fallback, maximum) {
  const value = arguments_.get(name);
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new RangeError(`${name} must be an integer between 1 and ${maximum}`);
  }
  return parsed;
}

const requests = positiveInteger("requests", 1_000, 100_000);
const concurrency = positiveInteger("concurrency", 10, 250);
const warmup = positiveInteger("warmup", 100, 10_000);
const target = new URL(process.env.LAUNCHRAIL_BENCHMARK_URL ?? "http://127.0.0.1:4000/health");
if (
  !["127.0.0.1", "localhost", "::1"].includes(target.hostname) ||
  target.pathname !== "/health" ||
  target.search !== "" ||
  target.hash !== "" ||
  target.username !== "" ||
  target.password !== ""
) {
  throw new Error(
    "Benchmark target must be a loopback /health URL without credentials or query data",
  );
}

async function request() {
  const started = performance.now();
  const response = await fetch(target, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  const latencyMs = performance.now() - started;
  await response.arrayBuffer();
  return { latencyMs, status: response.status };
}

async function run(count, workers) {
  const results = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(count, workers) }, async () => {
      while (next < count) {
        const index = next++;
        results[index] = await request();
      }
    }),
  );
  return results;
}

await run(warmup, concurrency);
const startedAt = new Date().toISOString();
const started = performance.now();
const results = await run(requests, concurrency);
const elapsedSeconds = (performance.now() - started) / 1_000;
const sorted = results.map((result) => result.latencyMs).sort((left, right) => left - right);
const percentile = (fraction) =>
  sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
const errors = results.filter((result) => result.status < 200 || result.status >= 300).length;

process.stdout.write(
  `${JSON.stringify(
    {
      schemaVersion: 1,
      scenario: "api-health-latency",
      startedAt,
      target: `${target.origin}${target.pathname}`,
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      warmupRequests: warmup,
      measuredRequests: requests,
      concurrency,
      elapsedSeconds: Number(elapsedSeconds.toFixed(3)),
      requestsPerSecond: Number((requests / elapsedSeconds).toFixed(2)),
      latencyMs: {
        min: Number(sorted[0].toFixed(3)),
        median: Number(percentile(0.5).toFixed(3)),
        p95: Number(percentile(0.95).toFixed(3)),
        max: Number(sorted.at(-1).toFixed(3)),
      },
      non2xxResponses: errors,
      statusCounts: Object.fromEntries(
        [...new Set(results.map((result) => result.status))]
          .sort()
          .map((status) => [status, results.filter((result) => result.status === status).length]),
      ),
      limitations: [
        "Measures loopback process liveness only; it does not measure queue or database readiness.",
        "Record host load and LaunchRail commit separately; do not compare uncontrolled environments.",
      ],
    },
    null,
    2,
  )}\n`,
);

if (errors > 0) process.exitCode = 1;
