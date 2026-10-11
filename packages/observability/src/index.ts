import pino, { type Logger, type LoggerOptions } from "pino";

export class MetricsRegistry {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly histograms = new Map<
    string,
    {
      readonly buckets: Map<number, number>;
      readonly labels: Readonly<Record<string, string>>;
      readonly name: string;
      count: number;
      sum: number;
    }
  >();

  private key(name: string, labels: Readonly<Record<string, string>>): string {
    const suffix = Object.entries(labels)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}="${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`)
      .join(",");
    return suffix.length === 0 ? name : `${name}{${suffix}}`;
  }

  public increment(name: string, labels: Readonly<Record<string, string>> = {}): void {
    const key = this.key(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }

  public setGauge(
    name: string,
    value: number,
    labels: Readonly<Record<string, string>> = {},
  ): void {
    if (!Number.isFinite(value)) throw new RangeError("Metric gauge values must be finite");
    this.gauges.set(this.key(name, labels), value);
  }

  public observe(
    name: string,
    value: number,
    labels: Readonly<Record<string, string>> = {},
    bounds: readonly number[] = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  ): void {
    if (!Number.isFinite(value) || value < 0)
      throw new RangeError("Metric observations must be non-negative");
    const sortedBounds = [...new Set(bounds)].sort((left, right) => left - right);
    if (sortedBounds.some((bound) => !Number.isFinite(bound) || bound <= 0))
      throw new RangeError("Histogram bounds must be finite and positive");
    const key = this.key(name, labels);
    let histogram = this.histograms.get(key);
    if (histogram === undefined) {
      histogram = {
        buckets: new Map(sortedBounds.map((bound) => [bound, 0])),
        labels,
        name,
        count: 0,
        sum: 0,
      };
      this.histograms.set(key, histogram);
    }
    histogram.count += 1;
    histogram.sum += value;
    for (const bound of histogram.buckets.keys())
      if (value <= bound) histogram.buckets.set(bound, (histogram.buckets.get(bound) ?? 0) + 1);
  }

  public renderPrometheus(): string {
    const lines = [
      ...[...this.counters.entries()].map(([key, value]) => `${key} ${value}`),
      ...[...this.gauges.entries()].map(([key, value]) => `${key} ${value}`),
    ];
    for (const histogram of this.histograms.values()) {
      for (const [bound, count] of histogram.buckets) {
        lines.push(
          `${this.key(`${histogram.name}_bucket`, { ...histogram.labels, le: String(bound) })} ${count}`,
        );
      }
      lines.push(
        `${this.key(`${histogram.name}_bucket`, { ...histogram.labels, le: "+Inf" })} ${histogram.count}`,
        `${this.key(`${histogram.name}_sum`, histogram.labels)} ${histogram.sum}`,
        `${this.key(`${histogram.name}_count`, histogram.labels)} ${histogram.count}`,
      );
    }
    return (
      lines.sort((left, right) => left.localeCompare(right)).join("\n") +
      (lines.length === 0 ? "" : "\n")
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
