import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { ImageBuildError, type PreparedBuildContext } from "@launchrail/application";
import {
  computeRepositoryContextSha256,
  repositoryContextEmptyContentSha256,
  type RepositoryContextManifestEntry,
} from "@launchrail/source";

import { assertAbsoluteNonRootPath } from "./policy.js";

export interface BuildContextLimits {
  readonly maxFileBytes: number;
  readonly maxFileCount: number;
  readonly maxPathBytes: number;
  readonly maxTotalBytes: number;
  readonly maxTreeDepth: number;
}

export const buildContextDefaultLimits: BuildContextLimits = {
  maxFileBytes: 16_777_216,
  maxFileCount: 20_000,
  maxPathBytes: 1_024,
  maxTotalBytes: 268_435_456,
  maxTreeDepth: 64,
};

export interface PrivateBuildContextSnapshot {
  readonly contextDirectory: string;
  readonly dockerfilePath: string;
  readonly stageDirectory: string;
}

function contextError(
  code: "build_context_changed" | "build_context_invalid",
  message: string,
): ImageBuildError {
  return new ImageBuildError({
    code,
    failureCategory: "build_rejected",
    message,
    retryable: false,
  });
}

function isContained(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
}

function sameFilesystemEntry(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function validateLimits(limits: BuildContextLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive safe integer`);
    }
  }
  if (limits.maxFileBytes > limits.maxTotalBytes) {
    throw new RangeError("Build context file limit cannot exceed its total byte limit");
  }
}

export async function preparePrivateBuildRoot(rootDirectory: string): Promise<string> {
  assertAbsoluteNonRootPath(rootDirectory, "Build root");
  await mkdir(rootDirectory, { mode: 0o700, recursive: true });
  const stats = await lstat(rootDirectory);
  const userId = process.getuid?.();
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    (userId !== undefined && stats.uid !== userId) ||
    (stats.mode & 0o077) !== 0
  ) {
    throw contextError("build_context_invalid", "The private build root is not secure");
  }
  const resolved = await realpath(rootDirectory);
  if (resolved !== rootDirectory) {
    throw contextError("build_context_invalid", "The private build root is not secure");
  }
  return resolved;
}

export async function createPrivateBuildContextSnapshot(options: {
  readonly context: PreparedBuildContext;
  readonly limits?: BuildContextLimits;
  readonly rootDirectory: string;
  readonly signal: AbortSignal;
  readonly workItemId: string;
}): Promise<PrivateBuildContextSnapshot> {
  const limits = options.limits ?? buildContextDefaultLimits;
  validateLimits(limits);
  if (options.signal.aborted) {
    throw options.signal.reason ?? new DOMException("The operation was aborted", "AbortError");
  }
  const root = await preparePrivateBuildRoot(options.rootDirectory);
  const sourceStats = await lstat(options.context.contextDirectory).catch(() => undefined);
  if (sourceStats === undefined || !sourceStats.isDirectory() || sourceStats.isSymbolicLink()) {
    throw contextError("build_context_invalid", "The prepared build context is not a directory");
  }
  const sourceRoot = await realpath(options.context.contextDirectory);
  if (sourceRoot !== options.context.contextDirectory) {
    throw contextError("build_context_invalid", "The prepared build context is not canonical");
  }

  const stageDirectory = await mkdtemp(join(root, `.build-${options.workItemId}-`));
  const destinationRoot = join(stageDirectory, "context");
  await mkdir(destinationRoot, { mode: 0o700 });
  const manifest: RepositoryContextManifestEntry[] = [];
  let fileCount = 0;
  let totalBytes = 0;

  const copyDirectory = async (
    sourceDirectory: string,
    destinationDirectory: string,
    depth: number,
  ): Promise<void> => {
    if (options.signal.aborted) {
      throw options.signal.reason ?? new DOMException("The operation was aborted", "AbortError");
    }
    if (depth > limits.maxTreeDepth) {
      throw contextError("build_context_invalid", "The build context exceeds its depth limit");
    }
    const names: string[] = [];
    const handle = await opendir(sourceDirectory);
    for await (const entry of handle) {
      names.push(entry.name);
    }
    names.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
    for (const name of names) {
      const sourcePath = join(sourceDirectory, name);
      const relativePath = relative(sourceRoot, sourcePath).split(sep).join("/");
      if (Buffer.byteLength(relativePath) > limits.maxPathBytes) {
        throw contextError("build_context_invalid", "The build context exceeds its path limit");
      }
      const destinationPath = join(destinationDirectory, name);
      const before = await lstat(sourcePath);
      if (before.isDirectory() && !before.isSymbolicLink()) {
        await mkdir(destinationPath, { mode: 0o700 });
        manifest.push({
          contentSha256: repositoryContextEmptyContentSha256,
          kind: "directory",
          mode: "040000",
          path: relativePath,
          size: 0,
        });
        await copyDirectory(sourcePath, destinationPath, depth + 1);
        const after = await lstat(sourcePath);
        if (!sameFilesystemEntry(before, after)) {
          throw contextError(
            "build_context_changed",
            "The prepared build context changed during sealing",
          );
        }
        continue;
      }

      fileCount += 1;
      if (fileCount > limits.maxFileCount) {
        throw contextError("build_context_invalid", "The build context exceeds its file limit");
      }
      if (before.isSymbolicLink()) {
        const targetBytes = await readlink(sourcePath, { encoding: "buffer" });
        if (targetBytes.byteLength > limits.maxFileBytes) {
          throw contextError("build_context_invalid", "The build context exceeds its file limit");
        }
        let target: string;
        try {
          target = new TextDecoder("utf-8", { fatal: true }).decode(targetBytes);
        } catch {
          throw contextError(
            "build_context_invalid",
            "The build context contains an invalid symbolic link",
          );
        }
        if (isAbsolute(target) || target.includes("\0")) {
          throw contextError(
            "build_context_invalid",
            "The build context contains an unsafe symbolic link",
          );
        }
        const lexicalTarget = resolve(dirname(sourcePath), target);
        if (!isContained(sourceRoot, lexicalTarget)) {
          throw contextError(
            "build_context_invalid",
            "The build context contains an unsafe symbolic link",
          );
        }
        const resolvedTarget = await realpath(sourcePath).catch(() => undefined);
        if (resolvedTarget === undefined || !isContained(sourceRoot, resolvedTarget)) {
          throw contextError(
            "build_context_invalid",
            "The build context contains an unsafe symbolic link",
          );
        }
        await symlink(target, destinationPath);
        const after = await lstat(sourcePath);
        if (!sameFilesystemEntry(before, after)) {
          throw contextError(
            "build_context_changed",
            "The prepared build context changed during sealing",
          );
        }
        totalBytes += targetBytes.byteLength;
        manifest.push({
          contentSha256: createHash("sha256").update(targetBytes).digest("hex"),
          kind: "symlink",
          mode: "120000",
          path: relativePath,
          size: targetBytes.byteLength,
        });
      } else if (before.isFile()) {
        if (before.size > limits.maxFileBytes) {
          throw contextError("build_context_invalid", "The build context exceeds its file limit");
        }
        const source = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
        const destination = await open(
          destinationPath,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
          (before.mode & 0o111) === 0 ? 0o600 : 0o700,
        );
        const hash = createHash("sha256");
        let copied = 0;
        try {
          const opened = await source.stat();
          if (!opened.isFile() || !sameFilesystemEntry(before, opened)) {
            throw contextError(
              "build_context_changed",
              "The prepared build context changed during sealing",
            );
          }
          const buffer = Buffer.allocUnsafe(64 * 1024);
          for (;;) {
            if (options.signal.aborted) {
              throw (
                options.signal.reason ?? new DOMException("The operation was aborted", "AbortError")
              );
            }
            const { bytesRead } = await source.read(buffer, 0, buffer.byteLength, copied);
            if (bytesRead === 0) {
              break;
            }
            copied += bytesRead;
            if (copied > limits.maxFileBytes) {
              throw contextError(
                "build_context_invalid",
                "The build context exceeds its file limit",
              );
            }
            const chunk = buffer.subarray(0, bytesRead);
            hash.update(chunk);
            await destination.write(chunk);
          }
          await destination.sync();
          const afterOpen = await source.stat();
          const afterPath = await lstat(sourcePath);
          if (
            copied !== before.size ||
            !sameFilesystemEntry(before, afterOpen) ||
            !sameFilesystemEntry(before, afterPath)
          ) {
            throw contextError(
              "build_context_changed",
              "The prepared build context changed during sealing",
            );
          }
        } finally {
          await Promise.all([source.close(), destination.close()]);
        }
        totalBytes += copied;
        manifest.push({
          contentSha256: hash.digest("hex"),
          kind: "file",
          mode: (before.mode & 0o111) === 0 ? "100644" : "100755",
          path: relativePath,
          size: copied,
        });
      } else {
        throw contextError(
          "build_context_invalid",
          "The build context contains an unsupported entry",
        );
      }
      if (totalBytes > limits.maxTotalBytes) {
        throw contextError(
          "build_context_invalid",
          "The build context exceeds its total byte limit",
        );
      }
    }
  };

  try {
    await copyDirectory(sourceRoot, destinationRoot, 0);
    const contextSha256 = computeRepositoryContextSha256(manifest);
    if (contextSha256 !== options.context.contextSha256) {
      throw contextError(
        "build_context_changed",
        "The prepared build context no longer matches its seal",
      );
    }
    const configuredDockerfile = resolve(destinationRoot, options.context.dockerfilePath);
    const resolvedDockerfile = await realpath(configuredDockerfile).catch(() => undefined);
    const expectedDockerfile = resolve(destinationRoot, options.context.dockerfileResolvedPath);
    if (
      resolvedDockerfile === undefined ||
      resolvedDockerfile !== expectedDockerfile ||
      !isContained(destinationRoot, resolvedDockerfile)
    ) {
      throw contextError(
        "build_context_changed",
        "The prepared Dockerfile no longer matches its seal",
      );
    }
    const dockerfileBytes = await readFile(resolvedDockerfile);
    if (
      createHash("sha256").update(dockerfileBytes).digest("hex") !==
      options.context.dockerfileSha256
    ) {
      throw contextError(
        "build_context_changed",
        "The prepared Dockerfile no longer matches its seal",
      );
    }
    await chmod(destinationRoot, 0o500);
    return {
      contextDirectory: destinationRoot,
      dockerfilePath: resolvedDockerfile,
      stageDirectory,
    };
  } catch (error) {
    await removePrivateBuildContextSnapshot(stageDirectory);
    throw error;
  }
}

export async function removePrivateBuildContextSnapshot(stageDirectory: string): Promise<void> {
  const restoreDirectoryPermissions = async (directory: string): Promise<void> => {
    const stats = await lstat(directory);
    if (!stats.isDirectory() || stats.isSymbolicLink()) return;
    await chmod(directory, 0o700);
    const entries = await opendir(directory);
    for await (const entry of entries) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await restoreDirectoryPermissions(join(directory, entry.name));
      }
    }
  };
  await restoreDirectoryPermissions(stageDirectory).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
  await rm(stageDirectory, { force: true, recursive: true });
}
