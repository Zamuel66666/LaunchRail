import pino from "pino";
import { describe, expect, it } from "vitest";

import { serviceLoggerOptions } from "../src/index.js";

describe("service logger redaction", () => {
  it("removes secret canaries from root and nested request fields", () => {
    const canary = "launchrail-phase-four-canary-secret";
    let output = "";
    const destination = {
      write(chunk: string): void {
        output += chunk;
      },
    };
    const logger = pino(serviceLoggerOptions("api", "info"), destination);

    logger.info(
      {
        LAUNCHRAIL_SECRET_KEYRING: canary,
        body: {
          LAUNCHRAIL_SECRET_KEYRING: canary,
          keyring: canary,
          password: canary,
          safe: "body-visible",
          secretKeyring: canary,
          value: canary,
        },
        config: { LAUNCHRAIL_SECRET_KEYRING: canary },
        env: { LAUNCHRAIL_SECRET_KEYRING: canary },
        environment: { LAUNCHRAIL_SECRET_KEYRING: canary },
        keyring: canary,
        password: canary,
        req: {
          body: {
            LAUNCHRAIL_SECRET_KEYRING: canary,
            keyring: canary,
            password: canary,
            safe: "request-visible",
            secretKeyring: canary,
            value: canary,
          },
          headers: { authorization: canary, cookie: canary },
        },
        request: {
          body: {
            LAUNCHRAIL_SECRET_KEYRING: canary,
            keyring: canary,
            password: canary,
            safe: "request-alias-visible",
            secretKeyring: canary,
            value: canary,
          },
          headers: { authorization: canary, cookie: canary },
        },
        safe: "root-visible",
        secretKeyring: canary,
        value: canary,
      },
      "redaction probe",
    );

    expect(output).not.toContain(canary);
    const record = JSON.parse(output) as Readonly<Record<string, unknown>>;
    expect(record.safe).toBe("root-visible");
    expect(output).toContain("body-visible");
    expect(output).toContain("request-visible");
    expect(output).toContain("request-alias-visible");
    expect(output).toContain("[REDACTED]");
  });
});
