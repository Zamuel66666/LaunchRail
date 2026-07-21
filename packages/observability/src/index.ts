import pino, { type Logger, type LoggerOptions } from "pino";

export type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";

const redactPaths = [
  "authorization",
  "cookie",
  "password",
  "req.headers.authorization",
  "req.headers.cookie",
  "secret",
  "token",
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
