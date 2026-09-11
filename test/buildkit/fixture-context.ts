import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, opendir, readFile, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

import {
  computeRepositoryContextSha256,
  repositoryContextEmptyContentSha256,
  type RepositoryContextManifestEntry,
} from "../../packages/source/src/index.js";

export interface FixtureBuildContext {
  readonly contextDirectory: string;
  readonly contextSha256: string;
  readonly dockerfilePath: "Dockerfile";
  readonly dockerfileResolvedPath: "Dockerfile";
  readonly dockerfileSha256: string;
  dispose(): Promise<void>;
}

async function manifestEntries(root: string): Promise<readonly RepositoryContextManifestEntry[]> {
  const entries: RepositoryContextManifestEntry[] = [];
  const pending = [root];

  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      break;
    }
    const handle = await opendir(current);
    for await (const directoryEntry of handle) {
      const absolutePath = join(current, directoryEntry.name);
      const relativePath = relative(root, absolutePath).split(sep).join("/");
      const stats = await lstat(absolutePath);
      if (stats.isDirectory() && !stats.isSymbolicLink()) {
        entries.push({
          contentSha256: repositoryContextEmptyContentSha256,
          kind: "directory",
          mode: "040000",
          path: relativePath,
          size: 0,
        });
        pending.push(absolutePath);
        continue;
      }
      if (stats.isSymbolicLink()) {
        const target = await readlink(absolutePath, { encoding: "buffer" });
        entries.push({
          contentSha256: createHash("sha256").update(target).digest("hex"),
          kind: "symlink",
          mode: "120000",
          path: relativePath,
          size: target.byteLength,
        });
        continue;
      }
      if (!stats.isFile()) {
        throw new Error(`Build fixture contains an unsupported entry: ${relativePath}`);
      }
      const contents = await readFile(absolutePath);
      entries.push({
        contentSha256: createHash("sha256").update(contents).digest("hex"),
        kind: "file",
        mode: (stats.mode & 0o111) === 0 ? "100644" : "100755",
        path: relativePath,
        size: contents.byteLength,
      });
    }
  }
  return entries;
}

export async function createFixtureBuildContext(name: string): Promise<FixtureBuildContext> {
  if (!/^[a-z][a-z-]*$/.test(name)) {
    throw new Error("Build fixture name must be a safe lowercase identifier");
  }
  const fixtureDirectory = resolve("examples", "build", name);
  const stagingDirectory = await mkdtemp(join(tmpdir(), "launchrail-buildkit-acceptance-"));
  const contextDirectory = join(stagingDirectory, "context");
  await mkdir(contextDirectory, { mode: 0o700 });
  await cp(fixtureDirectory, contextDirectory, { recursive: true });

  const dockerfile = await readFile(join(contextDirectory, "Dockerfile"));
  const contextSha256 = computeRepositoryContextSha256(await manifestEntries(contextDirectory));

  return {
    contextDirectory,
    contextSha256,
    dockerfilePath: "Dockerfile",
    dockerfileResolvedPath: "Dockerfile",
    dockerfileSha256: createHash("sha256").update(dockerfile).digest("hex"),
    dispose: async () => rm(dirname(contextDirectory), { force: true, recursive: true }),
  };
}
