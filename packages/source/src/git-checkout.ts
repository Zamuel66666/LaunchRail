import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

import {
  SourcePreparationError,
  type CheckoutRepositoryCommand,
  type PreparedDockerfile,
  type PreparedRepositoryCheckout,
  type RepositoryCheckout,
  type RepositoryTreeEntry,
  type ResolvedRepositoryRevision,
} from "@launchrail/application";

import {
  GitCommandExecutionError,
  type GitCommandExecutor,
  SpawnGitCommandExecutor,
} from "./git-process.js";
import {
  invalidSource,
  sourceCheckoutDefaultLimits,
  type SourceCheckoutLimits,
  validateCheckoutKey,
  validateDockerfilePath,
  validateLimits,
  validatePublicGitHubRepository,
  validateRevision,
  validateSha,
  validateTreeEntries,
} from "./policy.js";

const markerFileName = "checkout.json";
const lfsPointerPrefix = "version https://git-lfs.github.com/spec/v1\n";

interface CheckoutMarkerV1 {
  readonly checkoutKey: string;
  readonly commitSha: string;
  readonly contractVersion: 1;
  readonly dockerfile: PreparedDockerfile;
  readonly fileCount: number;
  readonly owner: string;
  readonly repository: string;
  readonly requestedRevision: string;
  readonly totalBytes: number;
  readonly treeSha: string;
}

export interface HardenedGitRepositoryCheckoutOptions {
  readonly executor?: GitCommandExecutor;
  readonly gitBinary?: string;
  readonly limits?: SourceCheckoutLimits;
  readonly rootDirectory: string;
}

interface ScannedCheckout {
  readonly fileCount: number;
  readonly totalBytes: number;
}

const gitSecurityArguments = [
  "-c",
  "credential.helper=",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.protectHFS=true",
  "-c",
  "core.protectNTFS=true",
  "-c",
  "core.symlinks=true",
  "-c",
  "fetch.fsckObjects=true",
  "-c",
  "http.followRedirects=false",
  "-c",
  "protocol.allow=never",
  "-c",
  "protocol.https.allow=always",
  "-c",
  "submodule.recurse=false",
  "-c",
  "transfer.fsckObjects=true",
] as const;

function isContained(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
}

function assertContained(root: string, candidate: string): void {
  if (!isContained(root, candidate)) {
    throw invalidSource("source_integrity_failed");
  }
}

function safeCheckoutFailure(): SourcePreparationError {
  return new SourcePreparationError({
    code: "checkout_failed",
    failureCategory: "source_unavailable",
    message: "The exact repository revision could not be checked out",
    retryable: true,
  });
}

function createGitEnvironment(stageDirectory: string): Readonly<Record<string, string>> {
  return {
    GCM_INTERACTIVE: "Never",
    GIT_ALLOW_PROTOCOL: "https",
    GIT_ASKPASS: "/bin/false",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_PROTOCOL_FROM_USER: "0",
    GIT_TERMINAL_PROMPT: "0",
    HOME: join(stageDirectory, "home"),
    LANG: "C",
    LC_ALL: "C",
    PATH: "/usr/bin:/bin",
    SSH_ASKPASS: "/bin/false",
    TMPDIR: join(stageDirectory, "tmp"),
    TZ: "UTC",
    XDG_CONFIG_HOME: join(stageDirectory, "xdg"),
  };
}

function markerMatches(
  marker: CheckoutMarkerV1,
  command: CheckoutRepositoryCommand,
  dockerfile: PreparedDockerfile,
  scan: ScannedCheckout,
): boolean {
  const resolved = command.resolvedRevision;
  return (
    marker.contractVersion === 1 &&
    marker.checkoutKey === command.checkoutKey &&
    marker.owner === resolved.owner &&
    marker.repository === resolved.repository &&
    marker.requestedRevision === resolved.requestedRevision &&
    marker.commitSha === resolved.commitSha &&
    marker.treeSha === resolved.treeSha &&
    marker.fileCount === scan.fileCount &&
    marker.totalBytes === scan.totalBytes &&
    marker.dockerfile.relativePath === dockerfile.relativePath &&
    marker.dockerfile.resolvedRelativePath === dockerfile.resolvedRelativePath &&
    marker.dockerfile.sha256 === dockerfile.sha256 &&
    marker.dockerfile.size === dockerfile.size
  );
}

function parseMarker(value: unknown): CheckoutMarkerV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidSource("source_integrity_failed");
  }
  return value as CheckoutMarkerV1;
}

export class HardenedGitRepositoryCheckout implements RepositoryCheckout {
  private readonly executor: GitCommandExecutor;
  private readonly gitBinary: string;
  private readonly limits: SourceCheckoutLimits;
  private readonly rootDirectory: string;

  public constructor({
    executor = new SpawnGitCommandExecutor(),
    gitBinary = "/usr/bin/git",
    limits = sourceCheckoutDefaultLimits,
    rootDirectory,
  }: HardenedGitRepositoryCheckoutOptions) {
    if (
      !isAbsolute(rootDirectory) ||
      resolve(rootDirectory) !== rootDirectory ||
      rootDirectory === parse(rootDirectory).root
    ) {
      throw new Error("Source checkout root must be an absolute normalized non-root path");
    }
    if (!isAbsolute(gitBinary)) {
      throw new Error("Git binary must be an absolute path");
    }
    validateLimits(limits);
    this.executor = executor;
    this.gitBinary = gitBinary;
    this.limits = limits;
    this.rootDirectory = rootDirectory;
  }

  private async prepareRoot(): Promise<string> {
    await mkdir(this.rootDirectory, { mode: 0o700, recursive: true });
    const rootStats = await lstat(this.rootDirectory);
    const currentUserId = process.getuid?.();
    if (
      !rootStats.isDirectory() ||
      rootStats.isSymbolicLink() ||
      (currentUserId !== undefined && rootStats.uid !== currentUserId) ||
      (rootStats.mode & 0o077) !== 0
    ) {
      throw invalidSource("source_integrity_failed");
    }
    const resolvedRoot = await realpath(this.rootDirectory);
    if (resolvedRoot !== this.rootDirectory) {
      throw invalidSource("source_integrity_failed");
    }
    return resolvedRoot;
  }

  private async executeGit(
    stageDirectory: string,
    signal: AbortSignal,
    ...arguments_: readonly string[]
  ): Promise<string> {
    try {
      const result = await this.executor.execute({
        arguments: [...gitSecurityArguments, ...arguments_],
        binary: this.gitBinary,
        cwd: stageDirectory,
        environment: createGitEnvironment(stageDirectory),
        maxOutputBytes: this.limits.maxProcessOutputBytes,
        signal,
      });
      return result.stdout.trim();
    } catch (error) {
      if (signal.aborted) {
        throw signal.reason ?? error;
      }
      if (error instanceof SourcePreparationError) {
        throw error;
      }
      if (error instanceof GitCommandExecutionError) {
        throw safeCheckoutFailure();
      }
      throw safeCheckoutFailure();
    }
  }

  private async directoryBytes(directory: string, limit: number): Promise<number> {
    let total = 0;
    const pending = [directory];
    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined) {
        break;
      }
      const handle = await opendir(current);
      for await (const entry of handle) {
        const path = join(current, entry.name);
        const entryStats = await lstat(path);
        if (entryStats.isDirectory() && !entryStats.isSymbolicLink()) {
          pending.push(path);
        } else {
          total += entryStats.size;
          if (total > limit) {
            throw invalidSource("source_limit_exceeded", "Repository exceeds source safety limits");
          }
        }
      }
    }
    return total;
  }

  private async executeFetchWithBudget(
    stageDirectory: string,
    gitDirectory: string,
    signal: AbortSignal,
    ...arguments_: readonly string[]
  ): Promise<void> {
    const budgetController = new AbortController();
    const effectiveSignal = AbortSignal.any([signal, budgetController.signal]);
    let monitoringStopped = false;
    const monitor = (async () => {
      while (!monitoringStopped && !budgetController.signal.aborted) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
        if (!monitoringStopped) {
          await this.directoryBytes(gitDirectory, this.limits.maxGitDirectoryBytes);
        }
      }
    })().catch((error) => budgetController.abort(error));
    try {
      await this.executeGit(stageDirectory, effectiveSignal, ...arguments_);
      await this.directoryBytes(gitDirectory, this.limits.maxGitDirectoryBytes);
    } catch (error) {
      if (signal.aborted) {
        throw signal.reason ?? error;
      }
      if (budgetController.signal.aborted) {
        throw budgetController.signal.reason ?? error;
      }
      throw error;
    } finally {
      monitoringStopped = true;
      await monitor;
    }
  }

  private async rejectsLfsPointer(path: string, size: number): Promise<boolean> {
    if (size < lfsPointerPrefix.length) {
      return false;
    }
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(lfsPointerPrefix.length);
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
      return bytesRead === buffer.byteLength && buffer.toString("utf8") === lfsPointerPrefix;
    } finally {
      await handle.close();
    }
  }

  private gitBlobSha(contents: Uint8Array): string {
    return createHash("sha1")
      .update(`blob ${contents.byteLength}\0`)
      .update(contents)
      .digest("hex");
  }

  private async gitFileBlobSha(path: string, size: number): Promise<string> {
    const hash = createHash("sha1").update(`blob ${size}\0`);
    for await (const chunk of createReadStream(path)) {
      hash.update(chunk as Buffer);
    }
    return hash.digest("hex");
  }

  private async scanCheckout(
    sourceDirectory: string,
    entries: readonly RepositoryTreeEntry[],
  ): Promise<ScannedCheckout> {
    const expectedFiles = new Map(
      entries.filter((entry) => entry.type === "blob").map((entry) => [entry.path, entry]),
    );
    const expectedDirectories = new Set(
      entries.filter((entry) => entry.type === "tree").map((entry) => entry.path),
    );
    const seen = new Set<string>();
    const seenDirectories = new Set<string>();
    let fileCount = 0;
    let totalBytes = 0;
    const pending = [sourceDirectory];
    const sourceRealPath = await realpath(sourceDirectory);

    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined) {
        break;
      }
      const handle = await opendir(current);
      for await (const directoryEntry of handle) {
        const path = join(current, directoryEntry.name);
        const relativePath = relative(sourceDirectory, path).split(sep).join("/");
        const entryStats = await lstat(path);
        if (entryStats.isDirectory() && !entryStats.isSymbolicLink()) {
          if (!expectedDirectories.has(relativePath) || seenDirectories.has(relativePath)) {
            throw invalidSource("source_integrity_failed");
          }
          seenDirectories.add(relativePath);
          pending.push(path);
          continue;
        }

        const expected = expectedFiles.get(relativePath);
        if (expected === undefined || seen.has(relativePath)) {
          throw invalidSource("source_integrity_failed");
        }
        seen.add(relativePath);
        fileCount += 1;
        totalBytes += entryStats.size;
        if (
          fileCount > this.limits.maxFileCount ||
          entryStats.size > this.limits.maxFileBytes ||
          totalBytes > this.limits.maxTotalBytes
        ) {
          throw invalidSource("source_limit_exceeded", "Repository exceeds source safety limits");
        }

        if (entryStats.isSymbolicLink()) {
          if (expected.mode !== "120000") {
            throw invalidSource("source_integrity_failed");
          }
          const targetBytes = await readlink(path, { encoding: "buffer" });
          let target: string;
          try {
            target = new TextDecoder("utf-8", { fatal: true }).decode(targetBytes);
          } catch {
            throw invalidSource("source_integrity_failed");
          }
          if (isAbsolute(target) || target.includes("\0")) {
            throw invalidSource("source_integrity_failed");
          }
          const lexicalTarget = resolve(dirname(path), target);
          assertContained(sourceDirectory, lexicalTarget);
          let targetRealPath: string;
          try {
            targetRealPath = await realpath(path);
          } catch {
            throw invalidSource("source_integrity_failed");
          }
          assertContained(sourceRealPath, targetRealPath);
          if (this.gitBlobSha(targetBytes) !== expected.sha) {
            throw invalidSource("source_integrity_failed");
          }
        } else if (entryStats.isFile()) {
          if (expected.mode !== "100644" && expected.mode !== "100755") {
            throw invalidSource("source_integrity_failed");
          }
          const executable = (entryStats.mode & 0o111) !== 0;
          if ((expected.mode === "100755") !== executable) {
            throw invalidSource("source_integrity_failed");
          }
          if (await this.rejectsLfsPointer(path, entryStats.size)) {
            throw invalidSource("source_integrity_failed", "Git LFS source is not supported");
          }
          if ((await this.gitFileBlobSha(path, entryStats.size)) !== expected.sha) {
            throw invalidSource("source_integrity_failed");
          }
        } else {
          throw invalidSource("source_integrity_failed");
        }

        if (entryStats.size !== expected.size) {
          throw invalidSource("source_integrity_failed");
        }
      }
    }

    if (seen.size !== expectedFiles.size || seenDirectories.size !== expectedDirectories.size) {
      throw invalidSource("source_integrity_failed");
    }
    return { fileCount, totalBytes };
  }

  private async inspectDockerfile(
    sourceDirectory: string,
    dockerfilePath: string,
  ): Promise<PreparedDockerfile> {
    const candidate = resolve(sourceDirectory, dockerfilePath);
    assertContained(sourceDirectory, candidate);
    let resolvedPath: string;
    try {
      resolvedPath = await realpath(candidate);
    } catch {
      throw new SourcePreparationError({
        code: "dockerfile_missing",
        failureCategory: "dockerfile_missing",
        message: "The configured Dockerfile does not exist",
        retryable: false,
      });
    }
    const sourceRealPath = await realpath(sourceDirectory);
    if (!isContained(sourceRealPath, resolvedPath)) {
      throw new SourcePreparationError({
        code: "dockerfile_unsafe",
        failureCategory: "source_invalid",
        message: "The configured Dockerfile escapes the repository checkout",
        retryable: false,
      });
    }
    const dockerfileStats = await stat(resolvedPath);
    if (
      !dockerfileStats.isFile() ||
      dockerfileStats.size === 0 ||
      dockerfileStats.size > this.limits.maxFileBytes
    ) {
      throw new SourcePreparationError({
        code: "dockerfile_unsafe",
        failureCategory: "source_invalid",
        message: "The configured Dockerfile is not a safe regular file",
        retryable: false,
      });
    }
    const contents = await readFile(resolvedPath);
    return {
      relativePath: dockerfilePath,
      resolvedRelativePath: relative(sourceRealPath, resolvedPath).split(sep).join("/"),
      sha256: createHash("sha256").update(contents).digest("hex"),
      size: dockerfileStats.size,
    };
  }

  private resultFromMarker(
    finalDirectory: string,
    marker: CheckoutMarkerV1,
    adopted: boolean,
  ): PreparedRepositoryCheckout {
    return {
      adopted,
      checkoutKey: marker.checkoutKey,
      commitSha: marker.commitSha,
      directory: join(finalDirectory, "source"),
      dockerfile: marker.dockerfile,
      fileCount: marker.fileCount,
      totalBytes: marker.totalBytes,
      treeSha: marker.treeSha,
    };
  }

  private async adopt(
    finalDirectory: string,
    command: CheckoutRepositoryCommand,
  ): Promise<PreparedRepositoryCheckout> {
    const finalStats = await lstat(finalDirectory);
    if (!finalStats.isDirectory() || finalStats.isSymbolicLink()) {
      throw invalidSource("source_integrity_failed");
    }
    const markerBytes = await readFile(join(finalDirectory, markerFileName));
    if (markerBytes.byteLength > 16_384) {
      throw invalidSource("source_integrity_failed");
    }
    let markerValue: unknown;
    try {
      markerValue = JSON.parse(markerBytes.toString("utf8")) as unknown;
    } catch {
      throw invalidSource("source_integrity_failed");
    }
    const marker = parseMarker(markerValue);
    const sourceDirectory = join(finalDirectory, "source");
    const scan = await this.scanCheckout(sourceDirectory, command.resolvedRevision.entries);
    const dockerfile = await this.inspectDockerfile(sourceDirectory, command.dockerfilePath);
    if (!markerMatches(marker, command, dockerfile, scan)) {
      throw invalidSource("source_integrity_failed");
    }
    return this.resultFromMarker(finalDirectory, marker, true);
  }

  public async prepare(command: CheckoutRepositoryCommand): Promise<PreparedRepositoryCheckout> {
    if (command.signal.aborted) {
      throw command.signal.reason ?? new DOMException("The operation was aborted", "AbortError");
    }
    validateCheckoutKey(command.checkoutKey);
    validateDockerfilePath(command.dockerfilePath);
    validatePublicGitHubRepository(command.resolvedRevision);
    validateRevisionIntegrity(command.resolvedRevision, this.limits);

    const root = await this.prepareRoot();
    const finalDirectory = join(root, command.checkoutKey);
    assertContained(root, finalDirectory);
    try {
      return await this.adopt(finalDirectory, command);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    const stageDirectory = await mkdtemp(join(root, `.prepare-${command.checkoutKey}-`));
    const gitDirectory = join(stageDirectory, "git");
    const sourceDirectory = join(stageDirectory, "source");
    const templateDirectory = join(stageDirectory, "templates");
    try {
      await Promise.all(
        ["home", "source", "templates", "tmp", "xdg"].map((name) =>
          mkdir(join(stageDirectory, name), { mode: 0o700 }),
        ),
      );
      await this.executeGit(
        stageDirectory,
        command.signal,
        "init",
        "--bare",
        "--quiet",
        `--template=${templateDirectory}`,
        gitDirectory,
      );
      const cloneUrl = `https://github.com/${command.resolvedRevision.owner}/${command.resolvedRevision.repository}.git`;
      const sourceRef = "refs/launchrail/source";
      await this.executeFetchWithBudget(
        stageDirectory,
        gitDirectory,
        command.signal,
        `--git-dir=${gitDirectory}`,
        "fetch",
        "--quiet",
        "--no-tags",
        "--no-recurse-submodules",
        "--depth=1",
        "--force",
        "--end-of-options",
        cloneUrl,
        `+${command.resolvedRevision.commitSha}:${sourceRef}`,
      );
      const actualCommit = await this.executeGit(
        stageDirectory,
        command.signal,
        `--git-dir=${gitDirectory}`,
        "rev-parse",
        "--verify",
        `${sourceRef}^{commit}`,
      );
      if (actualCommit !== command.resolvedRevision.commitSha) {
        throw invalidSource("source_integrity_failed");
      }
      const actualTree = await this.executeGit(
        stageDirectory,
        command.signal,
        `--git-dir=${gitDirectory}`,
        "rev-parse",
        "--verify",
        `${sourceRef}^{tree}`,
      );
      if (actualTree !== command.resolvedRevision.treeSha) {
        throw invalidSource("source_integrity_failed");
      }

      await this.executeGit(
        stageDirectory,
        command.signal,
        "-c",
        "core.bare=false",
        `--git-dir=${gitDirectory}`,
        `--work-tree=${sourceDirectory}`,
        "checkout",
        "--quiet",
        "--force",
        "--detach",
        sourceRef,
      );
      const scan = await this.scanCheckout(sourceDirectory, command.resolvedRevision.entries);
      const dockerfile = await this.inspectDockerfile(sourceDirectory, command.dockerfilePath);
      const marker: CheckoutMarkerV1 = {
        checkoutKey: command.checkoutKey,
        commitSha: command.resolvedRevision.commitSha,
        contractVersion: 1,
        dockerfile,
        fileCount: scan.fileCount,
        owner: command.resolvedRevision.owner,
        repository: command.resolvedRevision.repository,
        requestedRevision: command.resolvedRevision.requestedRevision,
        totalBytes: scan.totalBytes,
        treeSha: command.resolvedRevision.treeSha,
      };

      await Promise.all([
        rm(gitDirectory, { force: true, recursive: true }),
        rm(join(stageDirectory, "home"), { force: true, recursive: true }),
        rm(join(stageDirectory, "templates"), { force: true, recursive: true }),
        rm(join(stageDirectory, "tmp"), { force: true, recursive: true }),
        rm(join(stageDirectory, "xdg"), { force: true, recursive: true }),
      ]);
      await writeFile(join(stageDirectory, markerFileName), `${JSON.stringify(marker)}\n`, {
        mode: 0o600,
      });

      try {
        await rename(stageDirectory, finalDirectory);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST" && code !== "ENOTEMPTY") {
          throw error;
        }
        await rm(stageDirectory, { force: true, recursive: true });
        return this.adopt(finalDirectory, command);
      }
      return this.resultFromMarker(finalDirectory, marker, false);
    } catch (error) {
      await rm(stageDirectory, { force: true, recursive: true });
      if (command.signal.aborted) {
        throw command.signal.reason ?? error;
      }
      throw error;
    }
  }

  public async remove(checkoutKey: string): Promise<void> {
    validateCheckoutKey(checkoutKey);
    const root = await this.prepareRoot();
    const finalDirectory = join(root, checkoutKey);
    assertContained(root, finalDirectory);
    await rm(finalDirectory, { force: true, recursive: true });
  }
}

function validateRevisionIntegrity(
  resolvedRevision: ResolvedRepositoryRevision,
  limits: SourceCheckoutLimits,
): void {
  if (
    resolvedRevision.provider !== "github" ||
    resolvedRevision.canonicalRepositoryUrl !==
      `https://github.com/${resolvedRevision.owner}/${resolvedRevision.repository}`
  ) {
    throw invalidSource("source_integrity_failed");
  }
  validateSha(resolvedRevision.commitSha);
  validateSha(resolvedRevision.treeSha);
  validateRevision(resolvedRevision.requestedRevision);
  validateTreeEntries(resolvedRevision.entries, limits);
}
