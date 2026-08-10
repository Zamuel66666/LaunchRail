import { spawn } from "node:child_process";

export interface GitCommandRequest {
  readonly arguments: readonly string[];
  readonly binary: string;
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly maxOutputBytes: number;
  readonly signal: AbortSignal;
}

export interface GitCommandResult {
  readonly stdout: string;
}

export interface GitCommandExecutor {
  execute(request: GitCommandRequest): Promise<GitCommandResult>;
}

export class GitCommandExecutionError extends Error {
  public constructor(message = "Git command failed") {
    super(message);
    this.name = "GitCommandExecutionError";
  }
}

class GitCommandOutputLimitError extends Error {
  public constructor() {
    super("Git command output exceeded its safety limit");
    this.name = "GitCommandOutputLimitError";
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

export class SpawnGitCommandExecutor implements GitCommandExecutor {
  public constructor(private readonly killGraceMs = 250) {
    if (!Number.isSafeInteger(killGraceMs) || killGraceMs <= 0) {
      throw new Error("Git process kill grace must be a positive integer");
    }
  }

  public execute(request: GitCommandRequest): Promise<GitCommandResult> {
    if (request.signal.aborted) {
      return Promise.reject(
        request.signal.reason ?? new DOMException("The operation was aborted", "AbortError"),
      );
    }
    if (!Number.isSafeInteger(request.maxOutputBytes) || request.maxOutputBytes <= 0) {
      return Promise.reject(new Error("Git process output limit must be a positive integer"));
    }

    return new Promise((resolve, reject) => {
      const outputController = new AbortController();
      const effectiveSignal = AbortSignal.any([request.signal, outputController.signal]);
      let outputBytes = 0;
      const stdoutChunks: Buffer[] = [];
      let killTimer: NodeJS.Timeout | undefined;
      let settled = false;

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
              // The close handler still reports the bounded command failure.
            }
          }, this.killGraceMs);
          killTimer.unref();
        }
      };
      const onAbort = (): void => stop();
      effectiveSignal.addEventListener("abort", onAbort, { once: true });

      const countOutput = (chunk: Buffer, retain: boolean): void => {
        outputBytes += chunk.byteLength;
        if (outputBytes > request.maxOutputBytes) {
          outputController.abort(new GitCommandOutputLimitError());
          return;
        }
        if (retain) {
          stdoutChunks.push(Buffer.from(chunk));
        }
      };
      child.stdout.on("data", (chunk: Buffer) => countOutput(chunk, true));
      child.stderr.on("data", (chunk: Buffer) => countOutput(chunk, false));

      child.once("error", () => {
        if (settled) {
          return;
        }
        settled = true;
        effectiveSignal.removeEventListener("abort", onAbort);
        if (killTimer !== undefined) {
          clearTimeout(killTimer);
        }
        reject(new GitCommandExecutionError());
      });
      child.once("close", (code) => {
        if (settled) {
          return;
        }
        settled = true;
        effectiveSignal.removeEventListener("abort", onAbort);
        if (killTimer !== undefined) {
          clearTimeout(killTimer);
        }
        if (effectiveSignal.aborted) {
          reject(
            effectiveSignal.reason ?? new DOMException("The operation was aborted", "AbortError"),
          );
          return;
        }
        if (code !== 0) {
          reject(new GitCommandExecutionError());
          return;
        }
        resolve({ stdout: Buffer.concat(stdoutChunks).toString("utf8") });
      });
    });
  }
}
