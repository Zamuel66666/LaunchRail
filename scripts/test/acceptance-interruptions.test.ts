import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("physical interruption acceptance guards", () => {
  it("uses application stdout for the build boundary rather than unretained progress vertex names", () => {
    const fixture = readFileSync(
      new URL("../../examples/apps/slow-build/Dockerfile", import.meta.url),
      "utf8",
    );
    const harness = readFileSync(
      new URL("../acceptance-interruptions.mjs", import.meta.url),
      "utf8",
    );
    expect(fixture).toContain("RUN echo LAUNCHRAIL_INTERRUPTION_BUILD_BOUNDARY && sleep 10");
    expect(harness).toContain('x.content.includes("LAUNCHRAIL_INTERRUPTION_BUILD_BOUNDARY")');
  });
  const base = {
    ...process.env,
    LAUNCHRAIL_ACCEPTANCE_ALLOW_MUTATION: "DEDICATED_LOCAL_ACCEPTANCE",
    DATABASE_URL: "postgresql://fixture:fixture@127.0.0.1:5432/launchrail_clean_release",
    LAUNCHRAIL_ACCEPTANCE_SOURCE_REVISION: "a".repeat(40),
    LAUNCHRAIL_BOOTSTRAP_EMAIL: "fixture@launchrail.test",
    LAUNCHRAIL_BOOTSTRAP_PASSWORD: "synthetic-test-password",
    API_PORT: "4100",
    WORKER_HEALTH_PORT: "4001",
    WEB_ORIGIN: "http://localhost:3100",
    API_HOST: "127.0.0.1",
    WORKER_HEALTH_HOST: "127.0.0.1",
  };
  it.each([
    {
      env: { LAUNCHRAIL_ACCEPTANCE_ALLOW_MUTATION: "" },
      message: "Dedicated local acceptance acknowledgement is required",
    },
    {
      env: { DATABASE_URL: "postgresql://fixture:fixture@127.0.0.1:5432/production" },
      message: "A dedicated loopback acceptance database is required",
    },
    {
      env: { LAUNCHRAIL_ACCEPTANCE_SOURCE_REVISION: "main" },
      message: "A full source revision is required",
    },
    {
      env: { LAUNCHRAIL_BOOTSTRAP_EMAIL: "real-user@example.com" },
      message: "A synthetic acceptance owner is required",
    },
    { env: { API_HOST: "0.0.0.0" }, message: "Loopback application bindings are required" },
  ])(
    "rejects unsafe setup before starting processes or stopping infrastructure: $message",
    ({ env, message }) => {
      const result = spawnSync(process.execPath, ["scripts/acceptance-interruptions.mjs"], {
        env: { ...base, ...env },
        encoding: "utf8",
        timeout: 5_000,
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr.trim()).toBe(message);
    },
  );
});
