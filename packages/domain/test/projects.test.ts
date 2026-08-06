import { describe, expect, it } from "vitest";

import {
  ProjectValidationError,
  environmentVariableValueMaximumBytes,
  healthCheckPathMaximumLength,
  normalizeEnvironmentVariableName,
  normalizeProjectConfiguration,
  validateEnvironmentVariableValue,
  type ProjectConfigurationInput,
} from "../src/index.js";

const validInput: ProjectConfigurationInput = {
  defaultBranch: "main",
  dockerfilePath: "deploy/Dockerfile",
  healthCheckPath: "/health/ready",
  healthCheckPort: 3_000,
  name: "LaunchRail API",
  repositoryUrl: "https://github.com/LaunchRail/Control-Plane",
  runtimeConfig: {
    cpuMillicores: 500,
    memoryMegabytes: 512,
    processLimit: 128,
    readOnlyRootFilesystem: true,
  },
};

function expectInvalid(
  overrides: Partial<ProjectConfigurationInput>,
  field: string,
): ProjectValidationError {
  try {
    normalizeProjectConfiguration({ ...validInput, ...overrides });
  } catch (error) {
    expect(error).toBeInstanceOf(ProjectValidationError);
    const validationError = error as ProjectValidationError;
    expect(validationError.issues.some((issue) => issue.field === field)).toBe(true);
    return validationError;
  }
  throw new Error("Expected project configuration validation to fail");
}

describe("project configuration", () => {
  it("normalizes a complete safe configuration", () => {
    expect(
      normalizeProjectConfiguration({
        ...validInput,
        defaultBranch: "  feature/phase-4  ",
        dockerfilePath: "  deploy/Dockerfile  ",
        healthCheckPath: "  /health/ready  ",
        name: "  LaunchRail API  ",
      }),
    ).toEqual({
      ...validInput,
      defaultBranch: "feature/phase-4",
      dockerfilePath: "deploy/Dockerfile",
      healthCheckPath: "/health/ready",
      name: "LaunchRail API",
      repositoryUrl: "https://github.com/launchrail/control-plane",
    });
  });

  it.each([
    "http://github.com/owner/repository",
    "https://user:token@github.com/owner/repository",
    "https://github.com:443/owner/repository",
    "https://github.com/owner/repository?ref=main",
    "https://github.com/owner/repository#readme",
    "https://github.com/owner/repository.git",
    "https://github.com/owner/repository/",
    "https://github.com/owner/repository/extra",
    "https://github.com/owner%2frepository/other",
    "https://github.com/owner/repo%2esitory",
    "https://github.com/owner/repository\n",
    "https://github.com/-owner/repository",
    "https://github.com/owner-/repository",
    "https://github.com/owner--name/repository",
    "https://github.com/owner/repository name",
  ])("rejects an ambiguous or unsupported repository URL: %s", (repositoryUrl) => {
    const error = expectInvalid({ repositoryUrl }, "repositoryUrl");
    expect(error.message).not.toContain(repositoryUrl);
  });

  it.each([
    "",
    "feature branch",
    "../main",
    "feature//main",
    ".hidden",
    "feature/.hidden",
    "feature/main.lock",
    "main~1",
    "main^2",
    "main:next",
    "main?next",
    "main\\next",
  ])("rejects an unsafe default branch: %s", (defaultBranch) => {
    expectInvalid({ defaultBranch }, "defaultBranch");
  });

  it.each([
    "",
    "/Dockerfile",
    "../Dockerfile",
    "deploy/../Dockerfile",
    "deploy/./Dockerfile",
    "deploy//Dockerfile",
    "deploy\\Dockerfile",
    "deploy/%2e%2e/Dockerfile",
    "deploy/Docker file",
    "deploy/Dockerfile\n",
  ])("rejects an unsafe Dockerfile path: %s", (dockerfilePath) => {
    expectInvalid({ dockerfilePath }, "dockerfilePath");
  });

  it.each([
    "",
    "health",
    "//internal.example/health",
    "/../health",
    "/health/../ready",
    "/health//ready",
    "/health%2fready",
    "/health?token=value",
    "/health#fragment",
    "/health\\ready",
    "/health\nready",
    "/health\n",
  ])("rejects an unsafe health-check path: %s", (healthCheckPath) => {
    expectInvalid({ healthCheckPath }, "healthCheckPath");
  });

  it("enforces the health-check path length at 256 characters", () => {
    const maximumPath = `/${"h".repeat(healthCheckPathMaximumLength - 1)}`;

    expect(
      normalizeProjectConfiguration({ ...validInput, healthCheckPath: maximumPath }),
    ).toMatchObject({ healthCheckPath: maximumPath });
    expectInvalid({ healthCheckPath: `${maximumPath}h` }, "healthCheckPath");
  });

  it("accepts every inclusive runtime boundary", () => {
    expect(
      normalizeProjectConfiguration({
        ...validInput,
        healthCheckPort: 1,
        runtimeConfig: {
          cpuMillicores: 100,
          memoryMegabytes: 64,
          processLimit: 16,
          readOnlyRootFilesystem: false,
        },
      }),
    ).toMatchObject({ healthCheckPort: 1 });
    expect(
      normalizeProjectConfiguration({
        ...validInput,
        healthCheckPort: 65_535,
        runtimeConfig: {
          cpuMillicores: 4_000,
          memoryMegabytes: 8_192,
          processLimit: 1_024,
          readOnlyRootFilesystem: true,
        },
      }),
    ).toMatchObject({ healthCheckPort: 65_535 });
  });

  it.each([
    ["healthCheckPort", { healthCheckPort: 0 }],
    ["healthCheckPort", { healthCheckPort: 65_536 }],
    ["healthCheckPort", { healthCheckPort: 3_000.5 }],
    [
      "runtimeConfig.cpuMillicores",
      { runtimeConfig: { ...validInput.runtimeConfig, cpuMillicores: 99 } },
    ],
    [
      "runtimeConfig.cpuMillicores",
      { runtimeConfig: { ...validInput.runtimeConfig, cpuMillicores: 4_001 } },
    ],
    [
      "runtimeConfig.memoryMegabytes",
      { runtimeConfig: { ...validInput.runtimeConfig, memoryMegabytes: 63 } },
    ],
    [
      "runtimeConfig.memoryMegabytes",
      { runtimeConfig: { ...validInput.runtimeConfig, memoryMegabytes: 8_193 } },
    ],
    [
      "runtimeConfig.processLimit",
      { runtimeConfig: { ...validInput.runtimeConfig, processLimit: 15 } },
    ],
    [
      "runtimeConfig.processLimit",
      { runtimeConfig: { ...validInput.runtimeConfig, processLimit: 1_025 } },
    ],
  ] as const)("rejects an out-of-range %s", (field, overrides) => {
    expectInvalid(overrides, field);
  });

  it("trims the name and reports all invalid fields without echoing input", () => {
    const unsafeRepository = "https://user:canary@localhost/private";
    const error = expectInvalid(
      {
        healthCheckPort: 0,
        name: "   ",
        repositoryUrl: unsafeRepository,
      },
      "name",
    );

    expect(error.issues.map((issue) => issue.field)).toEqual(
      expect.arrayContaining(["healthCheckPort", "name", "repositoryUrl"]),
    );
    expect(error.message).not.toContain("canary");
  });
});

describe("project environment variables", () => {
  it.each(["DATABASE_URL", "_INTERNAL", "PORT_2"])("accepts the safe name %s", (name) => {
    expect(normalizeEnvironmentVariableName(`  ${name}  `)).toBe(name);
  });

  it.each(["", "lowercase", "2_PORT", "HAS-HYPHEN", "HAS SPACE", "ÜNICODE"])(
    "rejects the unsafe name %s",
    (name) => {
      expect(() => normalizeEnvironmentVariableName(name)).toThrow(ProjectValidationError);
    },
  );

  it("bounds secret values by UTF-8 byte length without trimming them", () => {
    const maximumAsciiValue = "a".repeat(environmentVariableValueMaximumBytes);
    const maximumUnicodeValue = "é".repeat(environmentVariableValueMaximumBytes / 2);

    expect(validateEnvironmentVariableValue(" value ")).toBe(" value ");
    expect(validateEnvironmentVariableValue(maximumAsciiValue)).toBe(maximumAsciiValue);
    expect(validateEnvironmentVariableValue(maximumUnicodeValue)).toBe(maximumUnicodeValue);
    expect(() => validateEnvironmentVariableValue("")).toThrow(ProjectValidationError);
    expect(() => validateEnvironmentVariableValue(`${maximumAsciiValue}a`)).toThrow(
      ProjectValidationError,
    );
    expect(() => validateEnvironmentVariableValue(`${maximumUnicodeValue}é`)).toThrow(
      ProjectValidationError,
    );
  });

  it("rejects null bytes without exposing the secret", () => {
    const secret = "phase-four-canary\0value";

    try {
      validateEnvironmentVariableValue(secret);
      throw new Error("Expected null-byte validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ProjectValidationError);
      expect((error as Error).message).not.toContain("phase-four-canary");
    }
  });
});
