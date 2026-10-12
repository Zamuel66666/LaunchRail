import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("physical interruption acceptance guards", () => {
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
