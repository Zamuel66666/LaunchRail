import { readFileSync } from "node:fs";
import { benchmarkEnvironment } from "./benchmark-environment.mjs";

const origin = new URL(process.env.LAUNCHRAIL_ACCEPTANCE_PROMETHEUS_URL ?? "http://127.0.0.1:9090");
if (
  origin.protocol !== "http:" ||
  !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname) ||
  origin.username ||
  origin.password ||
  origin.pathname !== "/" ||
  origin.search ||
  origin.hash
)
  throw new Error("Dashboard acceptance requires a credential-free loopback Prometheus origin");
const dashboard = JSON.parse(
  readFileSync(
    new URL("../ops/observability/grafana/launchrail-overview.json", import.meta.url),
    "utf8",
  ),
);
async function query(expression) {
  const url = new URL("/api/v1/query", origin);
  url.searchParams.set("query", expression);
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!response.body) throw new Error("Prometheus returned no response body");
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 1048576) {
        await reader.cancel();
        throw new Error("Prometheus response exceeded acceptance bound");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const raw = new TextDecoder().decode(Buffer.concat(chunks));
  const result = JSON.parse(raw);
  if (
    !response.ok ||
    result.status !== "success" ||
    result.data?.resultType !== "vector" ||
    !Array.isArray(result.data.result)
  )
    throw new Error("Prometheus query failed acceptance");
  return result.data.result;
}
const panels = [];
for (const panel of dashboard.panels) {
  for (const target of panel.targets ?? []) {
    const result = await query(target.expr);
    panels.push({ title: panel.title, expression: target.expr, sampleCount: result.length });
  }
}
const up = await query('up{job=~"launchrail-api|launchrail-worker"}');
for (const job of ["launchrail-api", "launchrail-worker"])
  if (!up.some((sample) => sample.metric.job === job && Number(sample.value[1]) === 1))
    throw new Error("Both LaunchRail metrics targets must scrape successfully");
const heartbeats = await query(
  "time() - launchrail_worker_last_successful_heartbeat_timestamp_seconds",
);
if (!heartbeats.some((sample) => Number(sample.value[1]) >= 0 && Number(sample.value[1]) <= 60))
  throw new Error("No recent worker heartbeat was observed");
const outcomes = await query("sum by (outcome) (launchrail_deployment_final_outcomes_total)");
if (!outcomes.some((sample) => sample.metric.outcome === "active" && Number(sample.value[1]) > 0))
  throw new Error("Acceptance requires a recorded activation metric");
process.stdout.write(
  JSON.stringify(
    {
      scenario: "prometheus-dashboard-queries",
      outcome: "passed",
      environment: benchmarkEnvironment(),
      panels,
      up,
      heartbeatAgeSeconds: heartbeats.map((sample) => Number(sample.value[1])),
      outcomes,
      limitations: [
        "Empty failure-specific series are reported, not fabricated as zero observations.",
        "Valid PromQL and live scrapes do not prove Grafana rendering or externally delivered alerts.",
      ],
    },
    null,
    2,
  ) + "\n",
);
