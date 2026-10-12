import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("evaluates versioned dashboard queries and requires live scrape and heartbeat evidence", async () => {
  let heartbeatAge = 10;
  const expressions: string[] = [];
  const server = createServer((request, response) => {
    const expression = new URL(request.url!, "http://localhost").searchParams.get("query")!;
    expressions.push(expression);
    const sample = (metric: Record<string, string>, value: number) => ({
      metric,
      value: [1, String(value)],
    });
    const result = expression.startsWith("up{")
      ? [sample({ job: "launchrail-api" }, 1), sample({ job: "launchrail-worker" }, 1)]
      : expression.startsWith("time()")
        ? [sample({}, heartbeatAge)]
        : expression === "sum by (outcome) (launchrail_deployment_final_outcomes_total)"
          ? [sample({ outcome: "active" }, 2)]
          : [];
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ status: "success", data: { resultType: "vector", result } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  const execute = () =>
    promisify(execFile)(process.execPath, ["scripts/acceptance-dashboard.mjs"], {
      env: {
        ...process.env,
        LAUNCHRAIL_ACCEPTANCE_PROMETHEUS_URL: `http://127.0.0.1:${address.port}`,
      },
      timeout: 10000,
    });
  try {
    const report = JSON.parse((await execute()).stdout);
    expect(report.outcome).toBe("passed");
    expect(report.panels.length).toBeGreaterThan(20);
    expect(report.panels.some((panel: { sampleCount: number }) => panel.sampleCount === 0)).toBe(
      true,
    );
    expect(report.up).toHaveLength(2);
    expect(expressions).toContain(
      "time() - launchrail_worker_last_successful_heartbeat_timestamp_seconds",
    );
    heartbeatAge = 61;
    await expect(execute()).rejects.toThrow("No recent worker heartbeat");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
