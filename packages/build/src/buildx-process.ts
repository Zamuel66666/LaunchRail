import { spawn } from "node:child_process";

export type BuildxCommandStream = "stderr" | "stdout";

export interface BuildxCommandRequest {
  readonly arguments: readonly string[];
  readonly binary: string;
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly maxLineBytes: number;
  readonly maxOutputBytes: number;
  readonly onLine?: (line: string, stream: BuildxCommandStream) => Promise<void>;
  readonly retainOutput?: boolean;
  readonly signal: AbortSignal;
}

export interface BuildxCommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

export interface BuildxCommandExecutor {
  execute(request: BuildxCommandRequest): Promise<BuildxCommandResult>;
}

export class BuildxCommandExecutionError extends Error {
  public readonly exitCode: number;

  public constructor(exitCode: number) {
    super("The Buildx command failed");
    this.name = "BuildxCommandExecutionError";
    this.exitCode = exitCode;
  }
}

export class BuildxCommandOutputLimitError extends Error {
  public constructor() {
    super("Buildx command output exceeded its safety limit");
    this.name = "BuildxCommandOutputLimitError";
  }
}

export class BuildxCommandUnavailableError extends Error {
  public constructor() {
    super("The configured Docker CLI could not be started");
    this.name = "BuildxCommandUnavailableError";
  }
}

function terminateProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) {
    return;
  }
  try {
    if (process.platform === "win32") {
      process.kill(pid, signal);
    } else {
      process.kill(-pid, signal);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw error;
    }
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

export class SpawnBuildxCommandExecutor implements BuildxCommandExecutor {
  public constructor(private readonly killGraceMs = 250) {
    assertPositiveInteger(killGraceMs, "Buildx process kill grace");
  }

  public async execute(request: BuildxCommandRequest): Promise<BuildxCommandResult> {
    assertPositiveInteger(request.maxLineBytes, "Buildx line output limit");
    assertPositiveInteger(request.maxOutputBytes, "Buildx total output limit");
    if (request.signal.aborted) {
      throw request.signal.reason ?? new DOMException("The operation was aborted", "AbortError");
    }

    const internalController = new AbortController();
    const signal = AbortSignal.any([request.signal, internalController.signal]);
    let totalOutputBytes = 0;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let killTimer: NodeJS.Timeout | undefined;

    const child = spawn(request.binary, [...request.arguments], {
      cwd: request.cwd,
      detached: process.platform !== "win32",
      env: { ...request.environment },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const stop = (): void => {
      try {
        terminateProcessGroup(child.pid, "SIGTERM");
      } finally {
        killTimer = setTimeout(() => {
          try {
            terminateProcessGroup(child.pid, "SIGKILL");
          } catch {
            // The process completion path reports the original bounded error.
          }
        }, this.killGraceMs);
        killTimer.unref();
      }
    };
    signal.addEventListener("abort", stop, { once: true });

    const consume = async (
      stream: NodeJS.ReadableStream,
      streamName: BuildxCommandStream,
      retained: Buffer[],
    ): Promise<void> => {
      let pending = Buffer.alloc(0);
      for await (const value of stream) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        totalOutputBytes += chunk.byteLength;
        if (totalOutputBytes > request.maxOutputBytes) {
          const error = new BuildxCommandOutputLimitError();
          internalController.abort(error);
          throw error;
        }
        if (request.retainOutput !== false) {
          retained.push(Buffer.from(chunk));
        }
        pending = pending.byteLength === 0 ? Buffer.from(chunk) : Buffer.concat([pending, chunk]);
        let newlineIndex = pending.indexOf(0x0a);
        while (newlineIndex >= 0) {
          if (newlineIndex > request.maxLineBytes) {
            const error = new BuildxCommandOutputLimitError();
            internalController.abort(error);
            throw error;
          }
          const line = pending.subarray(0, newlineIndex);
          pending = pending.subarray(newlineIndex + 1);
          if (request.onLine !== undefined) {
            await request.onLine(line.toString("utf8"), streamName);
          }
          newlineIndex = pending.indexOf(0x0a);
        }
        if (pending.byteLength > request.maxLineBytes) {
          const error = new BuildxCommandOutputLimitError();
          internalController.abort(error);
          throw error;
        }
      }
      if (pending.byteLength > 0 && request.onLine !== undefined) {
        await request.onLine(pending.toString("utf8"), streamName);
      }
    };

    const exit = new Promise<number>((resolve, reject) => {
      child.once("error", () => reject(new BuildxCommandUnavailableError()));
      child.once("close", (code) => resolve(code ?? 1));
    });

    try {
      const [exitCode] = await Promise.all([
        exit,
        consume(child.stdout, "stdout", stdoutChunks),
        consume(child.stderr, "stderr", stderrChunks),
      ]);
      if (signal.aborted) {
        throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
      }
      if (exitCode !== 0) {
        throw new BuildxCommandExecutionError(exitCode);
      }
      return {
        exitCode,
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
      };
    } catch (error) {
      if (!signal.aborted) {
        internalController.abort(error);
      }
      if (request.signal.aborted) {
        throw request.signal.reason ?? error;
      }
      if (internalController.signal.aborted) {
        throw internalController.signal.reason ?? error;
      }
      throw error;
    } finally {
      signal.removeEventListener("abort", stop);
      if (killTimer !== undefined) {
        clearTimeout(killTimer);
        // The leader may exit before descendants that ignored SIGTERM.
        terminateProcessGroup(child.pid, "SIGKILL");
      }
    }
  }
}
