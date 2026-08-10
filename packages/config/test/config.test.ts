import { describe, expect, it } from "vitest";

import {
  ConfigurationError,
  loadApiConfig,
  loadWebConfig,
  loadWorkerConfig,
  parseSecretKeyring,
} from "../src/index.js";

const secretKeyVersionOne = Buffer.alloc(32, 0x11).toString("base64url");
const secretKeyVersionTwo = Buffer.alloc(32, 0x22).toString("base64url");
const serviceEnvironment = {
  DATABASE_URL: "postgresql://launchrail:secret@localhost:5432/launchrail",
  LAUNCHRAIL_ACTIVE_SECRET_KEY_VERSION: "2",
  LAUNCHRAIL_SECRET_KEYRING: `1:${secretKeyVersionOne},2:${secretKeyVersionTwo}`,
  REDIS_URL: "redis://localhost:6379",
};

describe("configuration", () => {
  it("applies safe local defaults and coerces ports", () => {
    const apiConfig = loadApiConfig({ ...serviceEnvironment, API_PORT: "4100" });
    expect(apiConfig).toMatchObject({
      API_HOST: "127.0.0.1",
      API_PORT: 4100,
      LAUNCHRAIL_ACTIVE_SECRET_KEY_VERSION: 2,
      LOG_LEVEL: "info",
      NODE_ENV: "development",
      SESSION_ABSOLUTE_TTL_HOURS: 24,
      SESSION_COOKIE_NAME: "launchrail_session",
      SESSION_IDLE_TTL_MINUTES: 30,
      SIGN_IN_RATE_LIMIT_MAX: 5,
      WEB_ORIGIN: "http://localhost:3000",
    });
    expect([...apiConfig.LAUNCHRAIL_SECRET_KEYRING.keys()]).toEqual([1, 2]);
    expect(apiConfig.LAUNCHRAIL_SECRET_KEYRING.get(2)).toEqual(
      Uint8Array.from(Buffer.alloc(32, 0x22)),
    );
    expect(loadWorkerConfig(serviceEnvironment)).toMatchObject({
      WORKER_BACKOFF_BASE_MS: 1_000,
      WORKER_BACKOFF_CAP_MS: 60_000,
      WORKER_CONCURRENCY: 2,
      WORKER_HEALTH_HOST: "127.0.0.1",
      WORKER_HEALTH_PORT: 4001,
      WORKER_HEARTBEAT_INTERVAL_MS: 10_000,
      WORKER_JOB_TIMEOUT_MS: 300_000,
      WORKER_LEASE_MS: 60_000,
      WORKER_MAX_ATTEMPTS: 5,
      WORKER_MODE: "run",
      WORKER_QUEUE_NAME: "launchrail-deployments",
      WORKER_QUEUE_PREFIX: "launchrail",
      WORKER_RECONCILIATION_BATCH_SIZE: 100,
      WORKER_RECONCILIATION_INTERVAL_MS: 15_000,
      WORKER_SHUTDOWN_GRACE_MS: 30_000,
    });
    expect(loadWebConfig({})).toEqual({
      NEXT_PUBLIC_API_BASE_URL: "http://localhost:4000",
      NODE_ENV: "development",
    });
  });

  it("reports every missing service dependency without echoing environment values", () => {
    expect(() => loadApiConfig({ API_PORT: "not-a-port" })).toThrowError(ConfigurationError);

    try {
      loadApiConfig({ API_PORT: "not-a-port" });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect(String(error)).toContain("DATABASE_URL");
      expect(String(error)).toContain("LAUNCHRAIL_ACTIVE_SECRET_KEY_VERSION");
      expect(String(error)).toContain("LAUNCHRAIL_SECRET_KEYRING");
      expect(String(error)).toContain("REDIS_URL");
      expect(String(error)).toContain("API_PORT");
      expect(String(error)).not.toContain("not-a-port");
    }
  });

  it("rejects the documented development database password in production", () => {
    expect(() =>
      loadApiConfig({
        ...serviceEnvironment,
        DATABASE_URL: "postgresql://launchrail:launchrail_dev_only@localhost:5432/launchrail",
        NODE_ENV: "production",
      }),
    ).toThrow("development password cannot be used in production");
  });

  it("rejects unsafe production origins and invalid session lifetimes", () => {
    expect(() =>
      loadApiConfig({
        ...serviceEnvironment,
        NODE_ENV: "production",
        WEB_ORIGIN: "http://launchrail.example",
      }),
    ).toThrow("production browser origin must use HTTPS");

    expect(() =>
      loadApiConfig({
        ...serviceEnvironment,
        SESSION_ABSOLUTE_TTL_HOURS: "1",
        SESSION_IDLE_TTL_MINUTES: "61",
      }),
    ).toThrow("cannot exceed the absolute session lifetime");
  });

  it("parses bounded worker queue and lifecycle settings", () => {
    expect(
      loadWorkerConfig({
        ...serviceEnvironment,
        WORKER_BACKOFF_BASE_MS: "250",
        WORKER_BACKOFF_CAP_MS: "5000",
        WORKER_CONCURRENCY: "4",
        WORKER_HEARTBEAT_INTERVAL_MS: "1000",
        WORKER_JOB_TIMEOUT_MS: "10000",
        WORKER_LEASE_MS: "5000",
        WORKER_MAX_ATTEMPTS: "3",
        WORKER_MODE: "health-only",
        WORKER_QUEUE_NAME: "launchrail-test-deployments",
        WORKER_QUEUE_PREFIX: "launchrail_test",
        WORKER_RECONCILIATION_BATCH_SIZE: "25",
        WORKER_RECONCILIATION_INTERVAL_MS: "2000",
        WORKER_SHUTDOWN_GRACE_MS: "7500",
      }),
    ).toMatchObject({
      WORKER_BACKOFF_BASE_MS: 250,
      WORKER_BACKOFF_CAP_MS: 5_000,
      WORKER_CONCURRENCY: 4,
      WORKER_HEARTBEAT_INTERVAL_MS: 1_000,
      WORKER_JOB_TIMEOUT_MS: 10_000,
      WORKER_LEASE_MS: 5_000,
      WORKER_MAX_ATTEMPTS: 3,
      WORKER_MODE: "health-only",
      WORKER_QUEUE_NAME: "launchrail-test-deployments",
      WORKER_QUEUE_PREFIX: "launchrail_test",
      WORKER_RECONCILIATION_BATCH_SIZE: 25,
      WORKER_RECONCILIATION_INTERVAL_MS: 2_000,
      WORKER_SHUTDOWN_GRACE_MS: 7_500,
    });
  });

  it.each([
    ["backoff order", { WORKER_BACKOFF_BASE_MS: "60001" }],
    ["heartbeat lease order", { WORKER_HEARTBEAT_INTERVAL_MS: "60000" }],
    ["reconciliation lease order", { WORKER_RECONCILIATION_INTERVAL_MS: "60000" }],
    ["timeout heartbeat order", { WORKER_JOB_TIMEOUT_MS: "10000" }],
    ["unsafe queue name", { WORKER_QUEUE_NAME: "launchrail:deployments" }],
    ["excessive concurrency", { WORKER_CONCURRENCY: "33" }],
    ["excessive attempts", { WORKER_MAX_ATTEMPTS: "21" }],
  ])("rejects invalid worker setting relationships: %s", (_description, override) => {
    expect(() => loadWorkerConfig({ ...serviceEnvironment, ...override })).toThrow(
      ConfigurationError,
    );
  });

  it("parses one to eight unique versioned 32-byte base64url keys", () => {
    const keyring = parseSecretKeyring(
      `1:${secretKeyVersionOne},9007199254740991:${secretKeyVersionTwo}`,
    );

    expect([...keyring.keys()]).toEqual([1, 9_007_199_254_740_991]);
    expect(keyring.get(1)).toEqual(Uint8Array.from(Buffer.alloc(32, 0x11)));

    const eightEntries = Array.from(
      { length: 8 },
      (_, index) => `${index + 1}:${Buffer.alloc(32, index).toString("base64url")}`,
    ).join(",");
    expect(parseSecretKeyring(eightEntries).size).toBe(8);
  });

  it.each([
    ["empty", ""],
    ["zero version", `0:${secretKeyVersionOne}`],
    ["negative version", `-1:${secretKeyVersionOne}`],
    ["duplicate version", `1:${secretKeyVersionOne},1:${secretKeyVersionTwo}`],
    ["missing separator", secretKeyVersionOne],
    ["extra separator", `1:${secretKeyVersionOne}:extra`],
    ["padded base64", `1:${secretKeyVersionOne}=`],
    ["short key", `1:${Buffer.alloc(31).toString("base64url")}`],
    ["noncanonical base64", `1:${"_".repeat(43)}`],
    [
      "more than eight entries",
      Array.from(
        { length: 9 },
        (_, index) => `${index + 1}:${Buffer.alloc(32, index).toString("base64url")}`,
      ).join(","),
    ],
  ])("rejects an invalid %s keyring without echoing it", (_description, keyring) => {
    expect(() => parseSecretKeyring(keyring)).toThrow(ConfigurationError);

    try {
      parseSecretKeyring(keyring);
    } catch (error) {
      expect(String(error)).toContain("LAUNCHRAIL_SECRET_KEYRING");
      if (keyring.length > 0) {
        expect(String(error)).not.toContain(keyring);
      }
    }
  });

  it("requires the active key version to exist in the keyring", () => {
    expect(() =>
      loadApiConfig({
        ...serviceEnvironment,
        LAUNCHRAIL_ACTIVE_SECRET_KEY_VERSION: "3",
      }),
    ).toThrow("must identify a key in LAUNCHRAIL_SECRET_KEYRING");
  });

  it("does not echo malformed keyring material through API configuration errors", () => {
    const canary = `1:${secretKeyVersionOne},canary-secret-material`;

    try {
      loadApiConfig({ ...serviceEnvironment, LAUNCHRAIL_SECRET_KEYRING: canary });
      expect.fail("Expected malformed keyring configuration to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect(String(error)).toContain("LAUNCHRAIL_SECRET_KEYRING");
      expect(String(error)).not.toContain(canary);
      expect(String(error)).not.toContain("canary-secret-material");
    }
  });
});
