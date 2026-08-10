import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import type { ResolvedRepositoryRevision } from "@launchrail/application";

import {
  HardenedGitRepositoryCheckout,
  SpawnGitCommandExecutor,
  type GitCommandExecutor,
  type GitCommandRequest,
} from "../src/index.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function runGit(cwd: string, ...arguments_: readonly string[]): Promise<string> {
  const result = await execFileAsync("/usr/bin/git", [...arguments_], {
    cwd,
    encoding: "utf8",
    env: {
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_AUTHOR_NAME: "LaunchRail fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "LaunchRail fixture",
      HOME: cwd,
      PATH: "/usr/bin:/bin",
    },
    maxBuffer: 64 * 1024,
  });
  return result.stdout.trim();
}

class LocalTransportExecutor implements GitCommandExecutor {
  public readonly productionRequests: GitCommandRequest[] = [];
  private readonly executor = new SpawnGitCommandExecutor();

  public constructor(private readonly localUrl: string) {}

  public execute(request: GitCommandRequest) {
    this.productionRequests.push(request);
    return this.executor.execute({
      ...request,
      arguments: request.arguments.map((argument) => {
        if (argument === "https://github.com/launchrail/example.git") {
          return this.localUrl;
        }
        if (argument === "protocol.https.allow=always") {
          return "protocol.file.allow=always";
        }
        return argument;
      }),
      environment: { ...request.environment, GIT_ALLOW_PROTOCOL: "file" },
    });
  }
}

describe("exact local Git fixture", () => {
  it("keeps checkout pinned to commit A after the advertised branch moves to B", async () => {
    const root = await mkdtemp(join(tmpdir(), "launchrail-real-git-"));
    roots.push(root);
    const fixture = join(root, "fixture");
    const checkoutRoot = join(root, "checkouts");
    await Promise.all([mkdir(fixture, { mode: 0o700 }), mkdir(checkoutRoot, { mode: 0o700 })]);
    await runGit(fixture, "init", "--quiet", "--initial-branch=main");

    const sourceA = "FROM scratch\n# revision A\n";
    await writeFile(join(fixture, "Dockerfile"), sourceA);
    await runGit(fixture, "add", "--", "Dockerfile");
    await runGit(fixture, "commit", "--quiet", "-m", "revision A");
    const commitA = await runGit(fixture, "rev-parse", "HEAD^{commit}");
    const treeA = await runGit(fixture, "rev-parse", "HEAD^{tree}");
    const dockerfileBlobA = await runGit(fixture, "rev-parse", "HEAD:Dockerfile");

    await writeFile(join(fixture, "Dockerfile"), "FROM scratch\n# revision B\n");
    await runGit(fixture, "add", "--", "Dockerfile");
    await runGit(fixture, "commit", "--quiet", "-m", "revision B");
    expect(await runGit(fixture, "rev-parse", "HEAD^{commit}")).not.toBe(commitA);

    const resolvedRevision: ResolvedRepositoryRevision = {
      canonicalRepositoryUrl: "https://github.com/launchrail/example",
      commitSha: commitA,
      entries: [
        {
          mode: "100644",
          path: "Dockerfile",
          sha: dockerfileBlobA,
          size: Buffer.byteLength(sourceA),
          type: "blob",
        },
      ],
      owner: "launchrail",
      provider: "github",
      repository: "example",
      requestedRevision: "main",
      treeSha: treeA,
    };
    const transport = new LocalTransportExecutor(pathToFileURL(fixture).href);
    const checkout = new HardenedGitRepositoryCheckout({
      executor: transport,
      rootDirectory: checkoutRoot,
    });

    const prepared = await checkout.prepare({
      checkoutKey: "deployment_123",
      dockerfilePath: "Dockerfile",
      resolvedRevision,
      signal: new AbortController().signal,
    });

    expect(prepared).toMatchObject({ commitSha: commitA, treeSha: treeA });
    await expect(readFile(join(prepared.directory, "Dockerfile"), "utf8")).resolves.toBe(sourceA);
    const productionFetch = transport.productionRequests.find(({ arguments: args }) =>
      args.includes("fetch"),
    );
    expect(productionFetch?.arguments).toContain("https://github.com/launchrail/example.git");
    expect(productionFetch?.arguments).toContain(`+${commitA}:refs/launchrail/source`);
    expect(productionFetch?.environment.GIT_ALLOW_PROTOCOL).toBe("https");
  });
});
