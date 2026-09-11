import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

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
