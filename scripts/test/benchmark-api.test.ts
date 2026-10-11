import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { promisify } from "node:util";

import { expect, it } from "vitest";

it.each([true, false])(
  "records full-response latency and correctness for valid=%s health bodies",
  async (valid) => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.flushHeaders();
      setTimeout(
        () =>
          response.end(
            JSON.stringify(
              valid
                ? {
                    service: "api",
                    status: "ok",
                    version: "test",
                    timestamp: new Date().toISOString(),
                  }
                : { service: "wrong-service", status: "ok" },
            ),
          ),
        20,
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture port");
    try {
      const result = await promisify(execFile)(
        process.execPath,
        ["scripts/benchmark-api.mjs", "--requests=2", "--concurrency=1", "--warmup=1"],
        {
          env: {
            ...process.env,
            LAUNCHRAIL_BENCHMARK_URL: `http://127.0.0.1:${address.port}/health`,
          },
        },
      )
        .then((output) => ({ ...output, code: 0 }))
        .catch((error) => ({ stdout: error.stdout, code: error.code }));
      const report = JSON.parse(result.stdout);
      expect(result.code).toBe(valid ? 0 : 1);
      expect(report.invalidOrFailedResponses).toBe(valid ? 0 : 2);
      expect(report.warmupInvalidOrFailedResponses).toBe(valid ? 0 : 1);
      expect(report.non2xxResponses).toBe(0);
      expect(report.latencyMs.min).toBeGreaterThanOrEqual(15);
      expect(report.statusCounts).toEqual({ 200: 2 });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
