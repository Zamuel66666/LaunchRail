import { z } from "zod";

type EnvironmentSource = Readonly<Record<string, string | undefined>>;

const environmentSchema = z.enum(["development", "test", "production"]);
const logLevelSchema = z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);
const portSchema = z.coerce.number().int().min(1).max(65_535);
const positiveIntegerSchema = z.coerce.number().int().positive();
const urlSchema = z.string().url();

const sharedServiceSchema = z.object({
  DATABASE_URL: urlSchema,
  LOG_LEVEL: logLevelSchema.default("info"),
  NODE_ENV: environmentSchema.default("development"),
  REDIS_URL: urlSchema,
});

const apiSchema = sharedServiceSchema.extend({
  API_HOST: z.string().min(1).default("127.0.0.1"),
  API_PORT: portSchema.default(4000),
  SESSION_ABSOLUTE_TTL_HOURS: positiveIntegerSchema.max(168).default(24),
  SESSION_COOKIE_NAME: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/)
    .default("launchrail_session"),
  SESSION_IDLE_TTL_MINUTES: positiveIntegerSchema.max(1_440).default(30),
  SIGN_IN_RATE_LIMIT_MAX: positiveIntegerSchema.max(100).default(5),
  WEB_ORIGIN: urlSchema.default("http://localhost:3000"),
});

const workerSchema = sharedServiceSchema.extend({
  WORKER_HEALTH_HOST: z.string().min(1).default("127.0.0.1"),
  WORKER_HEALTH_PORT: portSchema.default(4001),
});

const webSchema = z.object({
  NEXT_PUBLIC_API_BASE_URL: urlSchema.default("http://localhost:4000"),
  NODE_ENV: environmentSchema.default("development"),
});

export type ApiConfig = z.infer<typeof apiSchema>;
export type WebConfig = z.infer<typeof webSchema>;
export type WorkerConfig = z.infer<typeof workerSchema>;

export class ConfigurationError extends Error {
  public readonly issues: readonly string[];

  public constructor(issues: readonly string[]) {
    super(`Invalid LaunchRail configuration:\n- ${issues.join("\n- ")}`);
    this.name = "ConfigurationError";
    this.issues = issues;
  }
}

function parseConfig<T>(schema: z.ZodType<T>, source: EnvironmentSource): T {
  const result = schema.safeParse(source);

  if (!result.success) {
    throw new ConfigurationError(
      result.error.issues.map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join(".") : "environment";
        return `${path}: ${issue.message}`;
      }),
    );
  }

  return result.data;
}

function rejectDevelopmentCredentialsInProduction(config: {
  readonly DATABASE_URL: string;
  readonly NODE_ENV: "development" | "test" | "production";
}): void {
  if (config.NODE_ENV !== "production") {
    return;
  }

  const databaseUrl = new URL(config.DATABASE_URL);
  if (databaseUrl.password === "launchrail_dev_only") {
    throw new ConfigurationError([
      "DATABASE_URL: the documented development password cannot be used in production",
    ]);
  }
}

function validateApiSecurity(config: ApiConfig): void {
  const issues: string[] = [];
  if (config.SESSION_IDLE_TTL_MINUTES > config.SESSION_ABSOLUTE_TTL_HOURS * 60) {
    issues.push("SESSION_IDLE_TTL_MINUTES: cannot exceed the absolute session lifetime");
  }
  if (config.NODE_ENV === "production" && new URL(config.WEB_ORIGIN).protocol !== "https:") {
    issues.push("WEB_ORIGIN: production browser origin must use HTTPS");
  }
  if (issues.length > 0) {
    throw new ConfigurationError(issues);
  }
}

export function loadApiConfig(source: EnvironmentSource = process.env): ApiConfig {
  const config = parseConfig(apiSchema, source);
  rejectDevelopmentCredentialsInProduction(config);
  validateApiSecurity(config);
  return config;
}

export function loadWorkerConfig(source: EnvironmentSource = process.env): WorkerConfig {
  const config = parseConfig(workerSchema, source);
  rejectDevelopmentCredentialsInProduction(config);
  return config;
}

export function loadWebConfig(source: EnvironmentSource = process.env): WebConfig {
  return parseConfig(webSchema, source);
}
