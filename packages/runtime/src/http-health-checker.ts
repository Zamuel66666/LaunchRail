import { request, type ClientRequest } from "node:http";

export interface HttpHealthCheckCommand {
  readonly host: string;
  readonly port: number;
  readonly path: string;
  readonly timeoutMs: number;
}

export interface HttpHealthCheckResult {
  readonly statusCode: number;
  readonly durationMs: number;
}

export type HttpHealthCheckFailureCode = "health_invalid_response" | "health_timeout";

export class HttpHealthCheckError extends Error {
  public readonly code: HttpHealthCheckFailureCode;
  public readonly durationMs: number;

  public constructor(code: HttpHealthCheckFailureCode, durationMs = 0) {
    super(
      code === "health_timeout"
        ? "The health check exceeded its time limit"
        : "The health check did not receive a valid HTTP response",
    );
    this.code = code;
    this.durationMs = durationMs;
    this.name = "HttpHealthCheckError";
  }
}

export async function checkHttpHealth(
  command: HttpHealthCheckCommand,
): Promise<HttpHealthCheckResult> {
  if (command.host !== "127.0.0.1" && command.host !== "::1")
    throw new RangeError("Health checks may target only the local runtime bridge");
  if (!Number.isSafeInteger(command.port) || command.port < 1 || command.port > 65_535)
    throw new RangeError("Health-check port must be between 1 and 65535");
  if (!command.path.startsWith("/") || command.path.startsWith("//") || command.path.includes("?"))
    throw new RangeError("Health-check path must be an origin-form path");
  if (
    !Number.isSafeInteger(command.timeoutMs) ||
    command.timeoutMs < 1 ||
    command.timeoutMs > 30_000
  )
    throw new RangeError("Health-check timeout must be between 1 and 30000 milliseconds");
  const started = Date.now();
  return new Promise((resolve, reject) => {
    let currentRequest: ClientRequest | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const fail = (error: HttpHealthCheckError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(retryTimer);
      reject(error);
      currentRequest?.destroy();
    };
    const timer = setTimeout(
      () => fail(new HttpHealthCheckError("health_timeout", Date.now() - started)),
      command.timeoutMs,
    );
    const attempt = () => {
      if (settled) return;
      currentRequest = request(
        { hostname: command.host, port: command.port, path: command.path, method: "GET" },
        (response) => {
          response.resume();
          response.once("error", () =>
            fail(new HttpHealthCheckError("health_invalid_response", Date.now() - started)),
          );
          response.once("aborted", () =>
            fail(new HttpHealthCheckError("health_invalid_response", Date.now() - started)),
          );
          response.once("end", () => {
            if (settled) return;
            const statusCode = response.statusCode;
            if (statusCode === undefined || statusCode < 100 || statusCode > 599) {
              fail(new HttpHealthCheckError("health_invalid_response", Date.now() - started));
              return;
            }
            settled = true;
            clearTimeout(timer);
            resolve({ statusCode, durationMs: Date.now() - started });
          });
        },
      );
      currentRequest.once("error", (error: NodeJS.ErrnoException) => {
        if (settled) return;
        const remaining = command.timeoutMs - (Date.now() - started);
        if (error.code === "ECONNREFUSED" && remaining > 100) {
          retryTimer = setTimeout(attempt, 100);
          return;
        }
        fail(
          error instanceof HttpHealthCheckError
            ? error
            : new HttpHealthCheckError("health_invalid_response", Date.now() - started),
        );
      });
      currentRequest.end();
    };
    attempt();
  });
}
