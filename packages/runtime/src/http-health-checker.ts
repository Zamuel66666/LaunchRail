import { request } from "node:http";

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

export async function checkHttpHealth(
  command: HttpHealthCheckCommand,
): Promise<HttpHealthCheckResult> {
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
    const timer = setTimeout(
      () => request_.destroy(new Error("Health-check timed out")),
      command.timeoutMs,
    );
    const request_ = request(
      { hostname: command.host, port: command.port, path: command.path, method: "GET" },
      (response) => {
        response.resume();
        response.once("end", () => {
          clearTimeout(timer);
          resolve({ statusCode: response.statusCode ?? 0, durationMs: Date.now() - started });
        });
      },
    );
    request_.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    request_.end();
  });
}
