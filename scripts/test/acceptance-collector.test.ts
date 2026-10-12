import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";

import { expect, it } from "vitest";

it("bounds dedicated collector fixtures and rejects secrets without retaining them", async () => {
  const canary = "acceptance-private-canary-test";
  const child = spawn(process.execPath, ["scripts/acceptance-collector.mjs"], {
    env: {
      ...process.env,
      LAUNCHRAIL_ACCEPTANCE_ALLOW_COLLECTION: "DEDICATED_LOCAL_ACCEPTANCE",
      LAUNCHRAIL_ACCEPTANCE_TRACE_CANARY: canary,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  try {
    const [line] = await once(lines, "line");
    const { collector } = JSON.parse(line);
    const post = (path: string, body: unknown) =>
      fetch(`${collector}${path}`, { method: "POST", body: JSON.stringify(body) });
    const payload = {
      resourceSpans: [
        {
          resource: {
            attributes: [{ key: "service.name", value: { stringValue: "launchrail-test" } }],
          },
          scopeSpans: [{ spans: [{ name: "launchrail.acceptance.fixture" }] }],
        },
      ],
    };
    expect((await post("/control", { failNext: 4 })).status).toBe(400);
    expect((await post("/control", { forbiddenValues: ["short"] })).status).toBe(400);
    expect((await post("/control", { failNext: 1 })).status).toBe(200);
    expect((await post("/v1/traces", { ...payload, private: canary })).status).toBe(422);
    expect((await post("/v1/traces", payload)).status).toBe(503);
    expect((await post("/v1/traces", payload)).status).toBe(200);
    expect((await post("/v1/traces", {})).status).toBe(400);
    expect((await post("/v1/traces", { resourceSpans: [null] })).status).toBe(400);
    expect((await post("/v1/traces", { resourceSpans: [{ scopeSpans: [] }] })).status).toBe(400);
    expect((await post("/unknown", {})).status).toBe(404);
    expect((await post("/v1/traces", "x".repeat(2097152))).status).toBe(413);
    const report = await (await fetch(`${collector}/report`)).json();
    expect(report).toMatchObject({
      payloadCount: 1,
      spanCount: 1,
      rejectedSecrets: 1,
      forcedFailures: 1,
      serviceNames: ["launchrail-test"],
      spanNames: ["launchrail.acceptance.fixture"],
    });
    expect(JSON.stringify(report)).not.toContain(canary);
  } finally {
    lines.close();
    const closed = once(child, "exit");
    child.kill("SIGTERM");
    await closed;
  }
});
