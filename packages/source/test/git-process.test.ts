import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { SpawnGitCommandExecutor } from "../src/index.js";

const roots: string[] = [];
const fixture = fileURLToPath(new URL("./fixtures/process-fixture.mjs", import.meta.url));

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function testRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "launchrail-process-test-"));
  roots.push(root);
  return root;
}

async function waitForFile(path: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return await readFile(path, "utf8");
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw new Error("Process fixture did not write its PID");
}

async function waitForExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 5));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        return;
      }
      throw error;
    }
  }
  throw new Error("Grandchild process survived process-group termination");
}

describe("SpawnGitCommandExecutor", () => {
  it("terminates a command that exceeds its combined output bound", async () => {
    const root = await testRoot();
    const executor = new SpawnGitCommandExecutor(25);

    await expect(
      executor.execute({
        arguments: [fixture, "flood"],
        binary: process.execPath,
        cwd: root,
        environment: { PATH: "/usr/bin:/bin" },
        maxOutputBytes: 1_024,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("Git command output exceeded its safety limit");
  });

  it("kills the full detached process group on cancellation", async () => {
    const root = await testRoot();
    const pidFile = join(root, "grandchild.pid");
    const executor = new SpawnGitCommandExecutor(25);
    const controller = new AbortController();
    const operation = executor.execute({
      arguments: [fixture, "tree", pidFile],
      binary: process.execPath,
      cwd: root,
      environment: { PATH: "/usr/bin:/bin" },
      maxOutputBytes: 1_024,
      signal: controller.signal,
    });
    const grandchildPid = Number(await waitForFile(pidFile));
    const reason = new Error("worker shutdown");
    controller.abort(reason);

    await expect(operation).rejects.toBe(reason);
    await waitForExit(grandchildPid);
  });
});
