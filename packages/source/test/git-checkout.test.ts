import { createHash } from "node:crypto";
import { lstat, mkdtemp, mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ResolvedRepositoryRevision } from "@launchrail/application";

import {
  HardenedGitRepositoryCheckout,
  sourceCheckoutDefaultLimits,
  type GitCommandExecutor,
  type GitCommandRequest,
} from "../src/index.js";
import { GitCommandOutputLimitError } from "../src/git-process.js";

const commitSha = "a".repeat(40);
const treeSha = "b".repeat(40);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function testRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "launchrail-source-test-"));
  roots.push(root);
  return root;
}

function revision(entries: ResolvedRepositoryRevision["entries"]): ResolvedRepositoryRevision {
  return {
    canonicalRepositoryUrl: "https://github.com/launchrail/example",
    commitSha,
    entries,
    owner: "launchrail",
    provider: "github",
    repository: "example",
    requestedRevision: "main",
    treeSha,
  };
}

function gitBlobSha(contents: string): string {
  const bytes = Buffer.from(contents);
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}

class FixtureExecutor implements GitCommandExecutor {
  public readonly calls: GitCommandRequest[] = [];

  public constructor(
    private readonly materialize: (directory: string) => Promise<void>,
    private readonly reportedCommit = commitSha,
    private readonly reportedTree = treeSha,
  ) {}

  public async execute(request: GitCommandRequest): Promise<{ readonly stdout: string }> {
    this.calls.push(request);
    const command = request.arguments;
    if (command.includes("init")) {
      const gitDirectory = command.at(-1);
      if (gitDirectory !== undefined) {
        await mkdir(gitDirectory, { recursive: true });
      }
    } else if (command.includes("fetch")) {
      const gitDirectory = command.find((argument) => argument.startsWith("--git-dir="))?.slice(10);
      if (gitDirectory !== undefined) {
        await writeFile(join(gitDirectory, "pack"), "bounded-pack");
      }
    } else if (command.includes("rev-parse")) {
      return {
        stdout: command.some((argument) => argument.endsWith("^{tree}"))
          ? this.reportedTree
          : this.reportedCommit,
      };
    } else if (command.includes("checkout")) {
      const workTree = command.find((argument) => argument.startsWith("--work-tree="))?.slice(12);
      if (workTree !== undefined) {
        await this.materialize(workTree);
      }
    }
    return { stdout: "" };
  }
}

describe("HardenedGitRepositoryCheckout", () => {
  it("rejects the filesystem root before it can change permissions", async () => {
    const before = (await lstat("/")).mode;
    expect(
      () =>
        new HardenedGitRepositoryCheckout({
          executor: new FixtureExecutor(async () => undefined),
          rootDirectory: "/",
        }),
    ).toThrow("absolute normalized non-root path");
    expect((await lstat("/")).mode).toBe(before);
  });

  it("checks out an exact revision with isolated Git configuration and adopts it on retry", async () => {
    const root = await testRoot();
    const dockerfile = "FROM scratch\n";
    const executor = new FixtureExecutor(async (directory) => {
      await writeFile(join(directory, "Dockerfile"), dockerfile);
    });
    const checkout = new HardenedGitRepositoryCheckout({ executor, rootDirectory: root });
    const resolvedRevision = revision([
      {
        mode: "100644",
        path: "Dockerfile",
        sha: gitBlobSha(dockerfile),
        size: Buffer.byteLength(dockerfile),
        type: "blob",
      },
    ]);
    const command = {
      checkoutKey: "deployment_123",
      dockerfilePath: "Dockerfile",
      resolvedRevision,
      signal: new AbortController().signal,
    } as const;

    const first = await checkout.prepare(command);
    const callCount = executor.calls.length;
    const second = await checkout.prepare(command);

    expect(first).toMatchObject({
      adopted: false,
      checkoutKey: "deployment_123",
      commitSha,
      dockerfile: {
        relativePath: "Dockerfile",
        resolvedRelativePath: "Dockerfile",
        size: Buffer.byteLength(dockerfile),
      },
      fileCount: 1,
      totalBytes: Buffer.byteLength(dockerfile),
      treeSha,
    });
    expect(second).toEqual({ ...first, adopted: true });
    expect(executor.calls).toHaveLength(callCount);
    expect(executor.calls.some(({ arguments: arguments_ }) => arguments_.includes("fetch"))).toBe(
      true,
    );
    const fetch = executor.calls.find(({ arguments: arguments_ }) => arguments_.includes("fetch"));
    expect(fetch?.arguments).toContain("https://github.com/launchrail/example.git");
    expect(fetch?.arguments).toContain(`+${commitSha}:refs/launchrail/source`);
    for (const call of executor.calls) {
      expect(call.environment).toMatchObject({
        GCM_INTERACTIVE: "Never",
        GIT_ALLOW_PROTOCOL: "https",
        GIT_ASKPASS: "/bin/false",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        HOME: expect.stringContaining(".prepare-deployment_123-"),
      });
      expect(call.environment).not.toHaveProperty("GITHUB_TOKEN");
      expect(call.environment).not.toHaveProperty("HTTPS_PROXY");
      expect(call.arguments).toContain("credential.helper=");
      expect(call.arguments).toContain("core.hooksPath=/dev/null");
      expect(call.arguments).toContain("http.followRedirects=false");
      expect(call.arguments).toContain("submodule.recurse=false");
    }

    await writeFile(join(first.directory, "Dockerfile"), dockerfile.replace("scratch", "mutated"));
    await expect(checkout.prepare(command)).rejects.toMatchObject({
      code: "source_integrity_failed",
      retryable: false,
    });
  });

  it("accepts an internal Dockerfile symlink and records the resolved contained path", async () => {
    const root = await testRoot();
    const dockerfile = "FROM scratch\n";
    const target = "container/Δockerfile";
    const executor = new FixtureExecutor(async (directory) => {
      await mkdir(join(directory, "container"));
      await writeFile(join(directory, target), dockerfile);
      await symlink(target, join(directory, "Dockerfile"));
    });
    const checkout = new HardenedGitRepositoryCheckout({ executor, rootDirectory: root });

    await expect(
      checkout.prepare({
        checkoutKey: "deployment_123",
        dockerfilePath: "Dockerfile",
        resolvedRevision: revision([
          { mode: "040000", path: "container", sha: "d".repeat(40), size: 0, type: "tree" },
          {
            mode: "100644",
            path: target,
            sha: gitBlobSha(dockerfile),
            size: Buffer.byteLength(dockerfile),
            type: "blob",
          },
          {
            mode: "120000",
            path: "Dockerfile",
            sha: gitBlobSha(target),
            size: Buffer.byteLength(target),
            type: "blob",
          },
        ]),
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      dockerfile: { relativePath: "Dockerfile", resolvedRelativePath: target },
      fileCount: 2,
    });
  });

  it("rejects an absolute symlink and removes every staging directory", async () => {
    const root = await testRoot();
    const target = "/etc/passwd";
    const executor = new FixtureExecutor(async (directory) => {
      await symlink(target, join(directory, "Dockerfile"));
    });
    const checkout = new HardenedGitRepositoryCheckout({ executor, rootDirectory: root });

    await expect(
      checkout.prepare({
        checkoutKey: "deployment_123",
        dockerfilePath: "Dockerfile",
        resolvedRevision: revision([
          {
            mode: "120000",
            path: "Dockerfile",
            sha: gitBlobSha(target),
            size: Buffer.byteLength(target),
            type: "blob",
          },
        ]),
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "source_integrity_failed", retryable: false });
    expect(await readdir(root)).toEqual([]);
  });

  it("rejects LFS pointers without invoking an inherited smudge filter", async () => {
    const root = await testRoot();
    const pointer = [
      "version https://git-lfs.github.com/spec/v1",
      `oid sha256:${"f".repeat(64)}`,
      "size 1000",
      "",
    ].join("\n");
    const executor = new FixtureExecutor(async (directory) => {
      await writeFile(join(directory, "Dockerfile"), pointer);
    });
    const checkout = new HardenedGitRepositoryCheckout({ executor, rootDirectory: root });

    await expect(
      checkout.prepare({
        checkoutKey: "deployment_123",
        dockerfilePath: "Dockerfile",
        resolvedRevision: revision([
          {
            mode: "100644",
            path: "Dockerfile",
            sha: gitBlobSha(pointer),
            size: Buffer.byteLength(pointer),
            type: "blob",
          },
        ]),
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "source_integrity_failed", retryable: false });
  });

  it("rejects a commit or tree mismatch before exposing a checkout", async () => {
    const root = await testRoot();
    const executor = new FixtureExecutor(async () => undefined, "f".repeat(40));
    const checkout = new HardenedGitRepositoryCheckout({ executor, rootDirectory: root });

    await expect(
      checkout.prepare({
        checkoutKey: "deployment_123",
        dockerfilePath: "Dockerfile",
        resolvedRevision: revision([]),
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "source_integrity_failed", retryable: false });
    expect(await readdir(root)).toEqual([]);
  });

  it("classifies a missing Dockerfile permanently and cleans partial source", async () => {
    const root = await testRoot();
    const readme = "healthy source\n";
    const executor = new FixtureExecutor(async (directory) => {
      await writeFile(join(directory, "README.md"), readme);
    });
    const checkout = new HardenedGitRepositoryCheckout({ executor, rootDirectory: root });

    await expect(
      checkout.prepare({
        checkoutKey: "deployment_123",
        dockerfilePath: "Dockerfile",
        resolvedRevision: revision([
          {
            mode: "100644",
            path: "README.md",
            sha: gitBlobSha(readme),
            size: Buffer.byteLength(readme),
            type: "blob",
          },
        ]),
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      code: "dockerfile_missing",
      failureCategory: "dockerfile_missing",
      retryable: false,
    });
    expect(await readdir(root)).toEqual([]);
  });

  it("rejects an empty Dockerfile", async () => {
    const root = await testRoot();
    const executor = new FixtureExecutor(async (directory) => {
      await writeFile(join(directory, "Dockerfile"), "");
    });
    const checkout = new HardenedGitRepositoryCheckout({ executor, rootDirectory: root });

    await expect(
      checkout.prepare({
        checkoutKey: "deployment_123",
        dockerfilePath: "Dockerfile",
        resolvedRevision: revision([
          {
            mode: "100644",
            path: "Dockerfile",
            sha: gitBlobSha(""),
            size: 0,
            type: "blob",
          },
        ]),
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "dockerfile_unsafe", retryable: false });
  });

  it("rejects an unexpected directory even when every file matches the manifest", async () => {
    const root = await testRoot();
    const dockerfile = "FROM scratch\n";
    const executor = new FixtureExecutor(async (directory) => {
      await writeFile(join(directory, "Dockerfile"), dockerfile);
      await mkdir(join(directory, "unexpected"));
    });
    const checkout = new HardenedGitRepositoryCheckout({ executor, rootDirectory: root });

    await expect(
      checkout.prepare({
        checkoutKey: "deployment_123",
        dockerfilePath: "Dockerfile",
        resolvedRevision: revision([
          {
            mode: "100644",
            path: "Dockerfile",
            sha: gitBlobSha(dockerfile),
            size: Buffer.byteLength(dockerfile),
            type: "blob",
          },
        ]),
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "source_integrity_failed", retryable: false });
  });

  it("aborts an in-progress fetch when Git storage crosses its byte budget", async () => {
    const root = await testRoot();
    const executor: GitCommandExecutor = {
      async execute(request) {
        const gitDirectory = request.arguments
          .find((argument) => argument.startsWith("--git-dir="))
          ?.slice(10);
        if (request.arguments.includes("init")) {
          const directory = request.arguments.at(-1);
          if (directory !== undefined) {
            await mkdir(directory, { recursive: true });
          }
          return { stdout: "" };
        }
        if (request.arguments.includes("fetch") && gitDirectory !== undefined) {
          await writeFile(join(gitDirectory, "oversized-pack"), "0123456789");
          return new Promise((_resolve, reject) => {
            if (request.signal.aborted) {
              reject(request.signal.reason);
              return;
            }
            request.signal.addEventListener("abort", () => reject(request.signal.reason), {
              once: true,
            });
          });
        }
        return { stdout: "" };
      },
    };
    const checkout = new HardenedGitRepositoryCheckout({
      executor,
      limits: { ...sourceCheckoutDefaultLimits, maxGitDirectoryBytes: 5 },
      rootDirectory: root,
    });

    await expect(
      checkout.prepare({
        checkoutKey: "deployment_123",
        dockerfilePath: "Dockerfile",
        resolvedRevision: revision([]),
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "source_limit_exceeded", retryable: false });
    expect(await readdir(root)).toEqual([]);
  });

  it("classifies Git output flooding as a permanent source limit violation", async () => {
    const root = await testRoot();
    const executor: GitCommandExecutor = {
      execute: async () => {
        throw new GitCommandOutputLimitError();
      },
    };
    const checkout = new HardenedGitRepositoryCheckout({ executor, rootDirectory: root });

    await expect(
      checkout.prepare({
        checkoutKey: "deployment_123",
        dockerfilePath: "Dockerfile",
        resolvedRevision: revision([]),
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "source_limit_exceeded", retryable: false });
    expect(await readdir(root)).toEqual([]);
  });
});
