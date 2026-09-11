import { tmpdir } from "node:os";

import { describe, expect, it, vi } from "vitest";

import {
  BuildxCommandOutputLimitError,
  SpawnBuildxCommandExecutor,
} from "../src/buildx-process.js";

const request = (script: string) => ({
  arguments: ["-e", script],
  binary: process.execPath,
  cwd: tmpdir(),
  environment: {},
  maxLineBytes: 1_024,
  maxOutputBytes: 4_096,
  signal: new AbortController().signal,
});

describe("Buildx process execution", () => {
  it("kills descendants when the process leader exits during cancellation", async () => {
    const controller = new AbortController();
    let descendantPid: number | undefined;
    const script = `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); process.stdout.write('ready\\\\n'); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'pipe', 'ignore'] });
      child.stdout.once('data', () => process.stdout.write(String(child.pid) + '\\n'));
      process.on('SIGTERM', () => process.exit(0));
      setInterval(() => {}, 1000);
    `;
    await expect(
      new SpawnBuildxCommandExecutor(20).execute({
        ...request(script),
        signal: controller.signal,
        onLine: async (line) => {
          descendantPid = Number(line);
          controller.abort(new Error("stop process tree"));
        },
      }),
    ).rejects.toThrow("stop process tree");
    expect(descendantPid).toBeGreaterThan(0);
    await vi.waitFor(() => {
      expect(() => process.kill(descendantPid!, 0)).toThrow();
    });
  });
  it("passes literal arguments without shell evaluation and separates output streams", async () => {
    const literal = "$(touch /invalid-path); `false`";
    const result = await new SpawnBuildxCommandExecutor().execute({
      ...request("process.stdout.write(process.argv[1]); process.stderr.write('diagnostic')"),
      arguments: [
        "-e",
        "process.stdout.write(process.argv[1]); process.stderr.write('diagnostic')",
        literal,
      ],
    });
    expect(result.stdout).toBe(literal);
    expect(result.stderr).toBe("diagnostic");
  });

  it("rejects output that exceeds the configured byte budget", async () => {
    await expect(
      new SpawnBuildxCommandExecutor().execute({
        ...request("process.stdout.write('x'.repeat(8192)); setInterval(() => {}, 1000)"),
      }),
    ).rejects.toBeInstanceOf(BuildxCommandOutputLimitError);
  });

  it("propagates cancellation while terminating a running command", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled by worker");
    const operation = new SpawnBuildxCommandExecutor().execute({
      ...request("process.stdout.write('ready\\n'); setInterval(() => {}, 1000)"),
      onLine: async () => {
        controller.abort(reason);
      },
      signal: controller.signal,
    });
    await expect(operation).rejects.toBe(reason);
  });
});
