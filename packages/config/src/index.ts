import { z } from "zod";

type EnvironmentSource = Readonly<Record<string, string | undefined>>;

const environmentSchema = z.enum(["development", "test", "production"]);
const logLevelSchema = z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);
const portSchema = z.coerce.number().int().min(1).max(65_535);
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

export function loadApiConfig(source: EnvironmentSource = process.env): ApiConfig {
  const config = parseConfig(apiSchema, source);
  rejectDevelopmentCredentialsInProduction(config);
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
