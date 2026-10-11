import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { promisify } from "node:util";

import { expect, it } from "vitest";

const execute = promisify(execFile);

it("uses the configured mutation origin and publishes measured event intervals without the session", async () => {
  const organizationId = "00000000-0000-4000-8000-000000000001";
  const projectId = "00000000-0000-4000-8000-000000000002";
  const deploymentId = "00000000-0000-4000-8000-000000000003";
  const cookie = `launchrail_session=${"a".repeat(43)}`;
  let creates = 0;
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "POST") {
      if (request.headers.origin !== "http://localhost:3100" || request.headers.cookie !== cookie) {
        response.writeHead(403).end("{}");
        return;
      }
      let body = "";
      for await (const chunk of request) body += chunk;
      expect(JSON.parse(body)).toEqual({ projectId, sourceRevision: "a".repeat(40) });
      creates += 1;
      response.end(JSON.stringify({ deployment: { deploymentId } }));
    } else if (request.url?.includes("/events")) {
      response.end(
        JSON.stringify({
          events: ["queued", "cloning", "building", "deploying", "health_checking", "active"].map(
            (toState, sequence) => ({
              toState,
              sequence,
              createdAt: new Date(sequence * 1000).toISOString(),
            }),
          ),
        }),
      );
    } else {
      response.end(
        JSON.stringify({
          deployments: [{ deploymentId, state: "active", createdAt: new Date(0).toISOString() }],
        }),
      );
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing fixture port");
  try {
    const result = await execute(process.execPath, ["scripts/benchmark-deployment.mjs"], {
      env: {
        ...process.env,
        WEB_ORIGIN: "http://localhost:3100",
        LAUNCHRAIL_BENCHMARK_API_URL: `http://127.0.0.1:${address.port}`,
        LAUNCHRAIL_BENCHMARK_ORGANIZATION_ID: organizationId,
        LAUNCHRAIL_BENCHMARK_PROJECT_ID: projectId,
        LAUNCHRAIL_BENCHMARK_SOURCE_REVISION: "a".repeat(40),
        LAUNCHRAIL_BENCHMARK_SESSION_COOKIE: cookie,
        LAUNCHRAIL_BENCHMARK_ALLOW_RELEASE_MUTATION: "I_UNDERSTAND_THIS_CREATES_A_DEPLOYMENT",
        LAUNCHRAIL_BENCHMARK_RUNS: "1",
      },
    });
    expect(creates).toBe(1);
    expect(result.stdout).not.toContain(cookie);
    const report = JSON.parse(result.stdout);
    expect(report.outcomes).toEqual({ active: 1, failed: 0, timeout: 0 });
    expect(report.runs[0].stageTimingStatus).toBe("available");
    for (const timing of Object.values(report.runs[0].stageDurationsMs)) expect(timing).toBe(1000);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
