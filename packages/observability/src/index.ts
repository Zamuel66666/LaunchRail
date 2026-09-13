import pino, { type Logger, type LoggerOptions } from "pino";

export class MetricsRegistry {
  private readonly counters = new Map<string, number>();

  public increment(name: string, labels: Readonly<Record<string, string>> = {}): void {
    const suffix = Object.entries(labels)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}="${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`)
      .join(",");
    const key = suffix.length === 0 ? name : `${name}{${suffix}}`;
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }

  public renderPrometheus(): string {
    return (
      [...this.counters.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => `${key} ${value}`)
        .join("\n") + (this.counters.size === 0 ? "" : "\n")
    );
  }
}

export type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";

const redactPaths = [
  "LAUNCHRAIL_SECRET_KEYRING",
  "authorization",
  "body.LAUNCHRAIL_SECRET_KEYRING",
  "body.keyring",
  "body.password",
  "body.secretKeyring",
  "body.value",
  "config.LAUNCHRAIL_SECRET_KEYRING",
  "cookie",
  "env.LAUNCHRAIL_SECRET_KEYRING",
  "environment.LAUNCHRAIL_SECRET_KEYRING",
  "keyring",
  "password",
  "req.body.LAUNCHRAIL_SECRET_KEYRING",
  "req.body.keyring",
  "req.body.password",
  "req.body.secretKeyring",
  "req.body.value",
  "req.headers.authorization",
  "req.headers.cookie",
  "request.body.LAUNCHRAIL_SECRET_KEYRING",
  "request.body.keyring",
  "request.body.password",
  "request.body.secretKeyring",
  "request.body.value",
  "request.headers.authorization",
  "request.headers.cookie",
  "secret",
  "secretKeyring",
  "token",
  "value",
] as const;

export function serviceLoggerOptions(service: string, level: LogLevel): LoggerOptions {
  return {
    base: { service },
    level,
    redact: {
      censor: "[REDACTED]",
      paths: [...redactPaths],
    },
  };
}

export function createServiceLogger(service: string, level: LogLevel): Logger {
  return pino(serviceLoggerOptions(service, level));
}
