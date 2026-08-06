export interface ProjectRuntimeConfig {
  readonly cpuMillicores: number;
  readonly memoryMegabytes: number;
  readonly processLimit: number;
  readonly readOnlyRootFilesystem: boolean;
}

export interface ProjectConfigurationInput {
  readonly defaultBranch: string;
  readonly dockerfilePath: string;
  readonly healthCheckPath: string;
  readonly healthCheckPort: number;
  readonly name: string;
  readonly repositoryUrl: string;
  readonly runtimeConfig: ProjectRuntimeConfig;
}

export interface ProjectConfiguration extends ProjectConfigurationInput {}

export const projectRuntimeLimits = {
  cpuMillicores: { maximum: 4_000, minimum: 100 },
  memoryMegabytes: { maximum: 8_192, minimum: 64 },
  processLimit: { maximum: 1_024, minimum: 16 },
} as const;

export const environmentVariableNameMaximumLength = 128;
export const environmentVariableValueMaximumBytes = 16_384;
export const healthCheckPathMaximumLength = 256;

export type ProjectValidationField =
  | "defaultBranch"
  | "dockerfilePath"
  | "environmentVariableName"
  | "environmentVariableValue"
  | "healthCheckPath"
  | "healthCheckPort"
  | "name"
  | "repositoryUrl"
  | "runtimeConfig.cpuMillicores"
  | "runtimeConfig.memoryMegabytes"
  | "runtimeConfig.processLimit"
  | "runtimeConfig.readOnlyRootFilesystem";

export type ProjectValidationCode =
  "invalid_format" | "invalid_type" | "not_integer" | "out_of_range" | "required" | "too_long";

export interface ProjectValidationIssue {
  readonly code: ProjectValidationCode;
  readonly field: ProjectValidationField;
  readonly message: string;
}

export class ProjectValidationError extends Error {
  public readonly issues: readonly ProjectValidationIssue[];

  public constructor(issues: readonly ProjectValidationIssue[]) {
    const fields = [...new Set(issues.map((issue) => issue.field))];
    super(`Invalid project input: ${fields.join(", ")}`);
    this.name = "ProjectValidationError";
    this.issues = issues;
  }
}

const controlCharacterPattern = /[\u0000-\u001f\u007f]/;
const repositoryOwnerPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const repositoryNamePattern = /^[A-Za-z0-9._-]{1,100}$/;
const gitReferencePattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;
const dockerfilePathPattern = /^[A-Za-z0-9._/-]+$/;
const healthCheckPathPattern = /^\/[A-Za-z0-9._~!$&'()*+,;=:@/-]*$/;
const environmentVariableNamePattern = /^[A-Z_][A-Z0-9_]*$/;

function addIssue(
  issues: ProjectValidationIssue[],
  field: ProjectValidationField,
  code: ProjectValidationCode,
  message: string,
): void {
  issues.push({ code, field, message });
}

function normalizeName(value: unknown, issues: ProjectValidationIssue[]): string {
  if (typeof value !== "string") {
    addIssue(issues, "name", "invalid_type", "Project name must be text");
    return "";
  }

  const normalized = value.trim();
  if (normalized.length === 0) {
    addIssue(issues, "name", "required", "Project name is required");
  } else if (normalized.length > 80) {
    addIssue(issues, "name", "too_long", "Project name must not exceed 80 characters");
  } else if (controlCharacterPattern.test(normalized)) {
    addIssue(issues, "name", "invalid_format", "Project name contains unsupported characters");
  }
  return normalized;
}

function normalizeRepositoryUrl(value: unknown, issues: ProjectValidationIssue[]): string {
  if (typeof value !== "string") {
    addIssue(issues, "repositoryUrl", "invalid_type", "Repository URL must be text");
    return "";
  }

  const normalized = value.trim();
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)$/.exec(normalized);
  const owner = match?.[1];
  const repository = match?.[2];
  const valid =
    owner !== undefined &&
    repository !== undefined &&
    !normalized.includes("%") &&
    !normalized.includes("\\") &&
    !controlCharacterPattern.test(value) &&
    repositoryOwnerPattern.test(owner) &&
    !owner.includes("--") &&
    repositoryNamePattern.test(repository) &&
    repository !== "." &&
    repository !== ".." &&
    !repository.toLowerCase().endsWith(".git");

  if (!valid) {
    addIssue(
      issues,
      "repositoryUrl",
      "invalid_format",
      "Repository must be a canonical public GitHub HTTPS URL",
    );
    return normalized;
  }

  return `https://github.com/${owner.toLowerCase()}/${repository.toLowerCase()}`;
}

function normalizeDefaultBranch(value: unknown, issues: ProjectValidationIssue[]): string {
  if (typeof value !== "string") {
    addIssue(issues, "defaultBranch", "invalid_type", "Default branch must be text");
    return "";
  }

  const normalized = value.trim();
  const segments = normalized.split("/");
  const valid =
    normalized.length > 0 &&
    normalized.length <= 255 &&
    gitReferencePattern.test(normalized) &&
    !controlCharacterPattern.test(value) &&
    !normalized.includes("..") &&
    !normalized.includes("//") &&
    !normalized.endsWith(".") &&
    normalized !== "@" &&
    segments.every(
      (segment) =>
        segment.length > 0 &&
        segment !== "." &&
        segment !== ".." &&
        !segment.startsWith(".") &&
        !segment.toLowerCase().endsWith(".lock"),
    );

  if (!valid) {
    addIssue(
      issues,
      "defaultBranch",
      normalized.length > 255 ? "too_long" : "invalid_format",
      "Default branch has an unsupported Git reference format",
    );
  }
  return normalized;
}

function normalizeDockerfilePath(value: unknown, issues: ProjectValidationIssue[]): string {
  if (typeof value !== "string") {
    addIssue(issues, "dockerfilePath", "invalid_type", "Dockerfile path must be text");
    return "";
  }

  const normalized = value.trim();
  const segments = normalized.split("/");
  const valid =
    normalized.length > 0 &&
    normalized.length <= 256 &&
    !normalized.startsWith("/") &&
    dockerfilePathPattern.test(normalized) &&
    !normalized.includes("\\") &&
    !normalized.includes("%") &&
    !controlCharacterPattern.test(value) &&
    segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");

  if (!valid) {
    addIssue(
      issues,
      "dockerfilePath",
      normalized.length > 256 ? "too_long" : "invalid_format",
      "Dockerfile path must be a safe relative POSIX path",
    );
  }
  return normalized;
}

function normalizeHealthCheckPath(value: unknown, issues: ProjectValidationIssue[]): string {
  if (typeof value !== "string") {
    addIssue(issues, "healthCheckPath", "invalid_type", "Health-check path must be text");
    return "";
  }

  const normalized = value.trim();
  const segments = normalized.slice(1).split("/");
  const valid =
    normalized.length > 0 &&
    normalized.length <= healthCheckPathMaximumLength &&
    normalized.startsWith("/") &&
    !normalized.startsWith("//") &&
    healthCheckPathPattern.test(normalized) &&
    !normalized.includes("//") &&
    !normalized.includes("%") &&
    !normalized.includes("?") &&
    !normalized.includes("#") &&
    !normalized.includes("\\") &&
    !controlCharacterPattern.test(value) &&
    segments.every((segment) => segment !== "." && segment !== "..");

  if (!valid) {
    addIssue(
      issues,
      "healthCheckPath",
      normalized.length > healthCheckPathMaximumLength ? "too_long" : "invalid_format",
      "Health-check path must be a safe origin-only path",
    );
  }
  return normalized;
}

function validateIntegerRange(
  value: unknown,
  field: ProjectValidationField,
  minimum: number,
  maximum: number,
  issues: ProjectValidationIssue[],
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    addIssue(issues, field, "invalid_type", `${field} must be a number`);
    return 0;
  }
  if (!Number.isInteger(value)) {
    addIssue(issues, field, "not_integer", `${field} must be an integer`);
  } else if (value < minimum || value > maximum) {
    addIssue(issues, field, "out_of_range", `${field} is outside the supported range`);
  }
  return value;
}

function normalizeRuntimeConfig(
  value: unknown,
  issues: ProjectValidationIssue[],
): ProjectRuntimeConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    addIssue(
      issues,
      "runtimeConfig.cpuMillicores",
      "invalid_type",
      "Runtime configuration must be an object",
    );
    return {
      cpuMillicores: 0,
      memoryMegabytes: 0,
      processLimit: 0,
      readOnlyRootFilesystem: false,
    };
  }

  const runtime = value as Readonly<Record<string, unknown>>;
  const cpuMillicores = validateIntegerRange(
    runtime.cpuMillicores,
    "runtimeConfig.cpuMillicores",
    projectRuntimeLimits.cpuMillicores.minimum,
    projectRuntimeLimits.cpuMillicores.maximum,
    issues,
  );
  const memoryMegabytes = validateIntegerRange(
    runtime.memoryMegabytes,
    "runtimeConfig.memoryMegabytes",
    projectRuntimeLimits.memoryMegabytes.minimum,
    projectRuntimeLimits.memoryMegabytes.maximum,
    issues,
  );
  const processLimit = validateIntegerRange(
    runtime.processLimit,
    "runtimeConfig.processLimit",
    projectRuntimeLimits.processLimit.minimum,
    projectRuntimeLimits.processLimit.maximum,
    issues,
  );
  if (typeof runtime.readOnlyRootFilesystem !== "boolean") {
    addIssue(
      issues,
      "runtimeConfig.readOnlyRootFilesystem",
      "invalid_type",
      "Read-only root filesystem setting must be a boolean",
    );
  }

  return {
    cpuMillicores,
    memoryMegabytes,
    processLimit,
    readOnlyRootFilesystem:
      typeof runtime.readOnlyRootFilesystem === "boolean" ? runtime.readOnlyRootFilesystem : false,
  };
}

export function normalizeProjectConfiguration(
  input: ProjectConfigurationInput,
): ProjectConfiguration {
  const issues: ProjectValidationIssue[] = [];
  const configuration: ProjectConfiguration = {
    defaultBranch: normalizeDefaultBranch(input.defaultBranch, issues),
    dockerfilePath: normalizeDockerfilePath(input.dockerfilePath, issues),
    healthCheckPath: normalizeHealthCheckPath(input.healthCheckPath, issues),
    healthCheckPort: validateIntegerRange(
      input.healthCheckPort,
      "healthCheckPort",
      1,
      65_535,
      issues,
    ),
    name: normalizeName(input.name, issues),
    repositoryUrl: normalizeRepositoryUrl(input.repositoryUrl, issues),
    runtimeConfig: normalizeRuntimeConfig(input.runtimeConfig, issues),
  };

  if (issues.length > 0) {
    throw new ProjectValidationError(issues);
  }
  return configuration;
}

export function normalizeEnvironmentVariableName(name: string): string {
  const normalized = typeof name === "string" ? name.trim() : "";
  const issues: ProjectValidationIssue[] = [];
  if (normalized.length === 0) {
    addIssue(
      issues,
      "environmentVariableName",
      "required",
      "Environment variable name is required",
    );
  } else if (normalized.length > environmentVariableNameMaximumLength) {
    addIssue(
      issues,
      "environmentVariableName",
      "too_long",
      `Environment variable name must not exceed ${environmentVariableNameMaximumLength} characters`,
    );
  } else if (!environmentVariableNamePattern.test(normalized)) {
    addIssue(
      issues,
      "environmentVariableName",
      "invalid_format",
      "Environment variable name must use uppercase letters, digits, and underscores",
    );
  }

  if (issues.length > 0) {
    throw new ProjectValidationError(issues);
  }
  return normalized;
}

export function validateEnvironmentVariableValue(value: string): string {
  const issues: ProjectValidationIssue[] = [];
  if (typeof value !== "string") {
    addIssue(
      issues,
      "environmentVariableValue",
      "invalid_type",
      "Environment variable value must be text",
    );
  } else {
    const byteLength = new TextEncoder().encode(value).byteLength;
    if (byteLength === 0) {
      addIssue(
        issues,
        "environmentVariableValue",
        "required",
        "Environment variable value is required",
      );
    } else if (byteLength > environmentVariableValueMaximumBytes) {
      addIssue(
        issues,
        "environmentVariableValue",
        "too_long",
        `Environment variable value must not exceed ${environmentVariableValueMaximumBytes} bytes`,
      );
    } else if (value.includes("\0")) {
      addIssue(
        issues,
        "environmentVariableValue",
        "invalid_format",
        "Environment variable value contains an unsupported null byte",
      );
    }
  }

  if (issues.length > 0) {
    throw new ProjectValidationError(issues);
  }
  return value;
}
