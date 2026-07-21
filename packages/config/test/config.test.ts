import { describe, expect, it } from "vitest";

import {
  ConfigurationError,
  loadApiConfig,
  loadWebConfig,
  loadWorkerConfig,
} from "../src/index.js";

const serviceEnvironment = {
  DATABASE_URL: "postgresql://launchrail:secret@localhost:5432/launchrail",
  REDIS_URL: "redis://localhost:6379",
};

describe("configuration", () => {
  it("applies safe local defaults and coerces ports", () => {
    expect(loadApiConfig({ ...serviceEnvironment, API_PORT: "4100" })).toMatchObject({
      API_HOST: "127.0.0.1",
      API_PORT: 4100,
      LOG_LEVEL: "info",
      NODE_ENV: "development",
    });
    expect(loadWorkerConfig(serviceEnvironment)).toMatchObject({
      WORKER_HEALTH_HOST: "127.0.0.1",
      WORKER_HEALTH_PORT: 4001,
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
      expect(String(error)).toContain("REDIS_URL");
      expect(String(error)).toContain("API_PORT");
      expect(String(error)).not.toContain("not-a-port");
    }
  });

  it("rejects the documented development database password in production", () => {
    expect(() =>
      loadApiConfig({
        DATABASE_URL: "postgresql://launchrail:launchrail_dev_only@localhost:5432/launchrail",
        NODE_ENV: "production",
        REDIS_URL: "redis://localhost:6379",
      }),
    ).toThrow("development password cannot be used in production");
  });
});
