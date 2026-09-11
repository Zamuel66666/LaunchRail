import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, parse, resolve } from "node:path";

import {
  ImageBuildError,
  type BuildImageCommand,
  type BuildLogSink,
  type BuiltImage,
  type ImageBuilder,
  type RemoveBuiltImageCommand,
} from "@launchrail/application";

import {
  buildContextDefaultLimits,
  createPrivateBuildContextSnapshot,
  type BuildContextLimits,
  preparePrivateBuildRoot,
  removePrivateBuildContextSnapshot,
} from "./context-snapshot.js";
import {
  BuildxCommandExecutionError,
  BuildxCommandOutputLimitError,
  BuildxCommandUnavailableError,
  type BuildxCommandExecutor,
  SpawnBuildxCommandExecutor,
} from "./buildx-process.js";
import {
  assertAbsoluteNonRootPath,
  createBuildLabels,
  createStableImageReference,
  labelsExactlyMatch,
  launchRailBuildLabelKeys,
  type BuildLabelRecord,
  validateBuilderName,
  validateBuildCommand,
  validateBuildIdentity,
} from "./policy.js";
import { BuildProgressConsumer, BuildProgressFormatError } from "./progress.js";

export { buildContextDefaultLimits, type BuildContextLimits };

export interface BuildKitLimits {
  readonly cpuMillicores: number;
  readonly maxImageBytes: number;
  readonly maxInspectBytes: number;
  readonly maxLogBytes: number;
  readonly maxLogChunkBytes: number;
  readonly maxMetadataBytes: number;
  readonly maxProgressBytes: number;
  readonly maxProgressLineBytes: number;
  readonly memoryMegabytes: number;
  readonly processLimit: number;
  readonly sharedMemoryMegabytes: number;
}

export const buildKitDefaultLimits: BuildKitLimits = {
  cpuMillicores: 1_000,
  maxImageBytes: 1_073_741_824,
  maxInspectBytes: 262_144,
  maxLogBytes: 1_048_576,
  maxLogChunkBytes: 16_384,
  maxMetadataBytes: 65_536,
  maxProgressBytes: 8_388_608,
  maxProgressLineBytes: 65_536,
  memoryMegabytes: 1_024,
  processLimit: 256,
  sharedMemoryMegabytes: 64,
};

export interface BuildKitImageBuilderOptions {
  readonly additionalRedactions?: readonly string[];
  readonly buildRootDirectory: string;
  readonly builderName?: string;
  readonly contextLimits?: Partial<BuildContextLimits>;
  readonly dockerBinary?: string;
  readonly dockerConfigDirectory: string;
  readonly dockerHost?: string;
  readonly executor?: BuildxCommandExecutor;
  readonly limits?: Partial<BuildKitLimits>;
  readonly platform: "linux/amd64" | "linux/arm64";
  readonly timeoutMs: number;
}

interface DockerImageInspection {
  readonly architecture: string;
  readonly id: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly os: string;
  readonly repoTags: readonly string[];
  readonly sizeBytes: number;
}

interface BuildResultMarkerV1 {
  readonly attempt: number;
  readonly cacheHitCount: number;
  readonly cacheMissCount: number;
  readonly contextSha256: string;
  readonly contractVersion: 1;
  readonly deploymentId: string;
  readonly dockerfileSha256: string;
  readonly imageDigest: string;
  readonly imageId: string;
  readonly imageReference: string;
  readonly organizationId: string;
  readonly platform: "linux/amd64" | "linux/arm64";
  readonly projectId: string;
  readonly sizeBytes: number;
  readonly sourceRevision: string;
  readonly treeRevision: string;
  readonly workItemId: string;
}

const digestPattern = /^sha256:[0-9a-f]{64}$/;

function buildError(options: ConstructorParameters<typeof ImageBuildError>[0]): ImageBuildError {
  return new ImageBuildError(options);
}

function positiveLimits<T extends Readonly<Record<string, number>>>(limits: T): T {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive safe integer`);
    }
  }
  return limits;
}

function parseUnixDockerHost(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RangeError("Docker host must be an absolute unix socket URL");
  }
  if (
    url.protocol !== "unix:" ||
    url.hostname !== "" ||
    !isAbsolute(url.pathname) ||
    resolve(url.pathname) !== url.pathname ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new RangeError("Docker host must be an absolute unix socket URL");
  }
}

function parseJsonObject(bytes: Buffer): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw buildError({
      code: "image_metadata_invalid",
      failureCategory: "internal_invariant_violation",
      message: "The image builder returned invalid metadata",
      retryable: false,
    });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw buildError({
      code: "image_metadata_invalid",
      failureCategory: "internal_invariant_violation",
      message: "The image builder returned invalid metadata",
      retryable: false,
    });
  }
  return value as Record<string, unknown>;
}

async function readBounded(path: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size <= 0 || stats.size > maxBytes) {
      throw buildError({
        code: "image_metadata_invalid",
        failureCategory: "internal_invariant_violation",
        message: "The image builder returned invalid metadata",
        retryable: false,
      });
    }
    return await readFile(handle);
  } finally {
    await handle.close();
  }
}

function markerMatchesCommand(
  marker: BuildResultMarkerV1,
  command: BuildImageCommand,
  reference: string,
  platform: "linux/amd64" | "linux/arm64",
): boolean {
  return (
    marker.contractVersion === 1 &&
    Number.isSafeInteger(marker.attempt) &&
    marker.attempt > 0 &&
    marker.deploymentId === command.identity.deploymentId &&
    marker.organizationId === command.identity.organizationId &&
    marker.projectId === command.identity.projectId &&
    marker.workItemId === command.identity.workItemId &&
    marker.sourceRevision === command.identity.sourceRevision &&
    marker.treeRevision === command.identity.treeRevision &&
    marker.contextSha256 === command.context.contextSha256 &&
    marker.dockerfileSha256 === command.context.dockerfileSha256 &&
    marker.imageReference === reference &&
    marker.platform === platform &&
    digestPattern.test(marker.imageId) &&
    digestPattern.test(marker.imageDigest) &&
    Number.isSafeInteger(marker.sizeBytes) &&
    marker.sizeBytes >= 0 &&
    Number.isSafeInteger(marker.cacheHitCount) &&
    marker.cacheHitCount >= 0 &&
    Number.isSafeInteger(marker.cacheMissCount) &&
    marker.cacheMissCount >= 0
  );
}

function markerToBuiltImage(marker: BuildResultMarkerV1, adopted: boolean): BuiltImage {
  return {
    adopted,
    cacheHitCount: marker.cacheHitCount,
    cacheMissCount: marker.cacheMissCount,
    imageDigest: marker.imageDigest,
    imageId: marker.imageId,
    imageReference: marker.imageReference,
    platform: marker.platform,
    sizeBytes: marker.sizeBytes,
  };
}

export class BuildKitImageBuilder implements ImageBuilder {
  private readonly additionalRedactions: readonly string[];
  private readonly buildRootDirectory: string;
  private readonly builderName: string;
  private readonly contextLimits: BuildContextLimits;
  private readonly dockerBinary: string;
  private readonly dockerConfigDirectory: string;
  private readonly dockerHost: string;
  private readonly executor: BuildxCommandExecutor;
  private readonly limits: BuildKitLimits;
  private readonly platform: "linux/amd64" | "linux/arm64";
  private readonly timeoutMs: number;

  public constructor(options: BuildKitImageBuilderOptions) {
    assertAbsoluteNonRootPath(options.buildRootDirectory, "Build root");
    assertAbsoluteNonRootPath(options.dockerConfigDirectory, "Docker configuration directory");
    this.dockerBinary = options.dockerBinary ?? "/usr/bin/docker";
    if (!isAbsolute(this.dockerBinary) || resolve(this.dockerBinary) !== this.dockerBinary) {
      throw new RangeError("Docker binary must be an absolute normalized path");
    }
    this.builderName = options.builderName ?? "launchrail-builder";
    validateBuilderName(this.builderName);
    this.dockerHost = options.dockerHost ?? "unix:///var/run/docker.sock";
    parseUnixDockerHost(this.dockerHost);
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new RangeError("Build timeout must be a positive safe integer");
    }
    this.limits = positiveLimits({ ...buildKitDefaultLimits, ...options.limits });
    this.contextLimits = positiveLimits({ ...buildContextDefaultLimits, ...options.contextLimits });
    if (this.limits.maxProgressLineBytes > this.limits.maxProgressBytes) {
      throw new RangeError("Progress line limit cannot exceed total progress limit");
    }
    if (this.limits.maxLogChunkBytes > this.limits.maxLogBytes) {
      throw new RangeError("Log chunk limit cannot exceed retained log limit");
    }
    if (this.contextLimits.maxFileBytes > this.contextLimits.maxTotalBytes) {
      throw new RangeError("Context file limit cannot exceed context total limit");
    }
    this.additionalRedactions = options.additionalRedactions ?? [];
    this.buildRootDirectory = options.buildRootDirectory;
    this.dockerConfigDirectory = options.dockerConfigDirectory;
    this.executor = options.executor ?? new SpawnBuildxCommandExecutor();
    this.platform = options.platform;
    this.timeoutMs = options.timeoutMs;
  }

  private environment(home: string): Readonly<Record<string, string>> {
    return {
      BUILDX_METADATA_PROVENANCE: "disabled",
      BUILDX_METADATA_WARNINGS: "0",
      DOCKER_BUILDKIT: "1",
      DOCKER_CONFIG: this.dockerConfigDirectory,
      DOCKER_HOST: this.dockerHost,
      HOME: home,
      LANG: "C",
      LC_ALL: "C",
      NO_COLOR: "1",
      PATH: "/usr/bin:/bin",
      TZ: "UTC",
    };
  }

  private async prepareDockerConfiguration(): Promise<void> {
    await mkdir(this.dockerConfigDirectory, { mode: 0o700, recursive: true });
    const stats = await lstat(this.dockerConfigDirectory);
    const userId = process.getuid?.();
    if (
      !stats.isDirectory() ||
      stats.isSymbolicLink() ||
      (userId !== undefined && stats.uid !== userId) ||
      (stats.mode & 0o077) !== 0 ||
      (await realpath(this.dockerConfigDirectory)) !== this.dockerConfigDirectory
    ) {
      throw buildError({
        code: "buildkit_unavailable",
        failureCategory: "infrastructure_unavailable",
        message: "The Docker client configuration is not private",
        retryable: true,
      });
    }
    const configPath = join(this.dockerConfigDirectory, "config.json");
    let configBytes: Buffer;
    try {
      configBytes = await readFile(configPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }
    if (configBytes.byteLength > 65_536) {
      throw buildError({
        code: "buildkit_unavailable",
        failureCategory: "infrastructure_unavailable",
        message: "The Docker client configuration is unsafe",
        retryable: false,
      });
    }
    const config = parseJsonObject(configBytes);
    if (
      config.auths !== undefined ||
      config.credsStore !== undefined ||
      config.credHelpers !== undefined
    ) {
      throw buildError({
        code: "buildkit_unavailable",
        failureCategory: "infrastructure_unavailable",
        message: "Registry credentials are not permitted in the build client configuration",
        retryable: false,
      });
    }
  }

  private resultPaths(
    root: string,
    workItemId: string,
  ): Readonly<{
    iid: string;
    marker: string;
    metadata: string;
  }> {
    const results = join(root, "results");
    return {
      iid: join(results, `${workItemId}.iid`),
      marker: join(results, `${workItemId}.json`),
      metadata: join(results, `${workItemId}.metadata.json`),
    };
  }

  private async executeInspect(
    reference: string,
    cwd: string,
    signal: AbortSignal,
  ): Promise<DockerImageInspection | undefined> {
    let result;
    try {
      result = await this.executor.execute({
        arguments: ["image", "inspect", "--format={{json .}}", reference],
        binary: this.dockerBinary,
        cwd,
        environment: this.environment(cwd),
        maxLineBytes: this.limits.maxInspectBytes,
        maxOutputBytes: this.limits.maxInspectBytes,
        signal,
      });
    } catch (error) {
      if (signal.aborted) {
        throw signal.reason ?? error;
      }
      if (error instanceof BuildxCommandExecutionError && error.exitCode === 1) {
        return undefined;
      }
      throw buildError({
        code: "buildkit_unavailable",
        failureCategory: "infrastructure_unavailable",
        message: "The Docker image store is unavailable",
        retryable: true,
      });
    }
    const object = parseJsonObject(Buffer.from(result.stdout));
    const config = object.Config;
    const labels =
      typeof config === "object" && config !== null && !Array.isArray(config)
        ? (config as Record<string, unknown>).Labels
        : undefined;
    if (
      typeof object.Id !== "string" ||
      !digestPattern.test(object.Id) ||
      typeof object.Architecture !== "string" ||
      typeof object.Os !== "string" ||
      !Number.isSafeInteger(object.Size) ||
      (object.Size as number) < 0 ||
      !Array.isArray(object.RepoTags) ||
      !object.RepoTags.every((tag) => typeof tag === "string") ||
      typeof labels !== "object" ||
      labels === null ||
      Array.isArray(labels) ||
      !Object.values(labels).every((value) => typeof value === "string")
    ) {
      throw buildError({
        code: "image_metadata_invalid",
        failureCategory: "internal_invariant_violation",
        message: "Docker returned invalid image metadata",
        retryable: false,
      });
    }
    return {
      architecture: object.Architecture,
      id: object.Id,
      labels: labels as Record<string, string>,
      os: object.Os,
      repoTags: object.RepoTags as string[],
      sizeBytes: object.Size as number,
    };
  }

  private assertInspection(
    inspection: DockerImageInspection,
    labels: BuildLabelRecord,
    reference: string,
    expectedImageId?: string,
  ): void {
    const expectedArchitecture = this.platform.slice("linux/".length);
    if (
      inspection.os !== "linux" ||
      inspection.architecture !== expectedArchitecture ||
      !inspection.repoTags.includes(reference) ||
      inspection.sizeBytes > this.limits.maxImageBytes ||
      (expectedImageId !== undefined && inspection.id !== expectedImageId) ||
      !labelsExactlyMatch(inspection.labels, labels)
    ) {
      throw buildError({
        code: "image_metadata_invalid",
        failureCategory: "internal_invariant_violation",
        message: "The built image identity does not match the requested deployment",
        retryable: false,
      });
    }
  }

  private async readMarker(path: string): Promise<BuildResultMarkerV1 | undefined> {
    let bytes: Buffer;
    try {
      bytes = await readBounded(path, this.limits.maxMetadataBytes);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
    return parseJsonObject(bytes) as unknown as BuildResultMarkerV1;
  }

  private async writeMarker(path: string, marker: BuildResultMarkerV1): Promise<void> {
    const temporary = `${path}.${process.pid}.${createHash("sha256").update(String(Date.now())).digest("hex").slice(0, 12)}.tmp`;
    await writeFile(temporary, `${JSON.stringify(marker)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  }

  private async readBuildDigests(
    metadataPath: string,
    iidPath: string,
  ): Promise<Readonly<{ imageDigest: string; imageId: string }>> {
    const [metadataBytes, iidBytes] = await Promise.all([
      readBounded(metadataPath, this.limits.maxMetadataBytes),
      readBounded(iidPath, 256),
    ]);
    const metadata = parseJsonObject(metadataBytes);
    const imageDigest = metadata["containerimage.digest"];
    const configDigest = metadata["containerimage.config.digest"];
    const imageId = iidBytes.toString("utf8").trim();
    if (
      typeof imageDigest !== "string" ||
      !digestPattern.test(imageDigest) ||
      typeof configDigest !== "string" ||
      !digestPattern.test(configDigest) ||
      !digestPattern.test(imageId) ||
      imageId !== configDigest
    ) {
      throw buildError({
        code: "image_metadata_invalid",
        failureCategory: "internal_invariant_violation",
        message: "BuildKit returned inconsistent image digests",
        retryable: false,
      });
    }
    return { imageDigest, imageId };
  }

  private async removeExactImage(
    reference: string,
    inspection: DockerImageInspection,
    labels: BuildLabelRecord,
    cwd: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (!labelsExactlyMatch(inspection.labels, labels)) {
      return;
    }
    try {
      await this.executor.execute({
        arguments: ["image", "rm", reference],
        binary: this.dockerBinary,
        cwd,
        environment: this.environment(cwd),
        maxLineBytes: this.limits.maxInspectBytes,
        maxOutputBytes: this.limits.maxInspectBytes,
        signal,
      });
    } catch (error) {
      if (signal.aborted) {
        throw signal.reason ?? error;
      }
      throw buildError({
        code: "image_cleanup_failed",
        failureCategory: "cleanup_failed",
        message: "The deployment image could not be removed safely",
        retryable: true,
      });
    }
  }

  private mapBuildFailure(
    error: unknown,
    callerSignal: AbortSignal,
    timeoutSignal: AbortSignal,
  ): never {
    if (callerSignal.aborted) {
      throw callerSignal.reason ?? error;
    }
    if (timeoutSignal.aborted) {
      throw buildError({
        code: "build_timeout",
        failureCategory: "build_timeout",
        message: "The image build exceeded its time limit",
        retryable: false,
      });
    }
    if (error instanceof ImageBuildError) {
      throw error;
    }
    if (error instanceof BuildxCommandOutputLimitError) {
      throw buildError({
        code: "build_output_limit_exceeded",
        failureCategory: "build_rejected",
        message: "The image build exceeded its output safety limit",
        retryable: false,
      });
    }
    if (error instanceof BuildProgressFormatError) {
      throw buildError({
        code: "image_metadata_invalid",
        failureCategory: "internal_invariant_violation",
        message: "BuildKit returned invalid progress data",
        retryable: false,
      });
    }
    if (error instanceof BuildxCommandUnavailableError) {
      throw buildError({
        code: "buildkit_unavailable",
        failureCategory: "infrastructure_unavailable",
        message: "The configured image builder is unavailable",
        retryable: true,
      });
    }
    if (error instanceof BuildxCommandExecutionError) {
      throw buildError({
        code: "build_failed",
        failureCategory: "build_failed",
        message: "The Dockerfile build did not complete successfully",
        retryable: false,
      });
    }
    throw buildError({
      code: "buildkit_unavailable",
      failureCategory: "infrastructure_unavailable",
      message: "The image builder is unavailable",
      retryable: true,
    });
  }

  public async build(command: BuildImageCommand, sink: BuildLogSink): Promise<BuiltImage> {
    validateBuildCommand(command);
    const timeoutController = new AbortController();
    const timeout = setTimeout(
      () => timeoutController.abort(new DOMException("Build timed out", "TimeoutError")),
      this.timeoutMs,
    );
    timeout.unref();
    const signal = AbortSignal.any([command.signal, timeoutController.signal]);
    let stageDirectory: string | undefined;
    let builtInspection: DockerImageInspection | undefined;
    let builtLabels: BuildLabelRecord | undefined;
    try {
      await this.prepareDockerConfiguration();
      const root = await preparePrivateBuildRoot(this.buildRootDirectory);
      const paths = this.resultPaths(root, command.identity.workItemId);
      await mkdir(parse(paths.marker).dir, { mode: 0o700, recursive: true });
      const reference = createStableImageReference(command.identity);
      const existing = await this.executeInspect(reference, root, signal);
      const marker = await this.readMarker(paths.marker);
      if (
        existing !== undefined &&
        marker !== undefined &&
        markerMatchesCommand(marker, command, reference, this.platform)
      ) {
        const labels = createBuildLabels(command, this.platform, marker.attempt);
        this.assertInspection(existing, labels, reference, marker.imageId);
        if (existing.sizeBytes !== marker.sizeBytes) {
          throw buildError({
            code: "image_metadata_invalid",
            failureCategory: "internal_invariant_violation",
            message: "The retained deployment image changed after it was recorded",
            retryable: false,
          });
        }
        return markerToBuiltImage(marker, true);
      }
      if (existing !== undefined) {
        const actualAttempt = Number(existing.labels[launchRailBuildLabelKeys.attempt]);
        const candidateLabels = createBuildLabels(command, this.platform, actualAttempt);
        if (
          !Number.isSafeInteger(actualAttempt) ||
          actualAttempt <= 0 ||
          !labelsExactlyMatch(existing.labels, candidateLabels)
        ) {
          throw buildError({
            code: "image_metadata_invalid",
            failureCategory: "internal_invariant_violation",
            message: "The requested deployment image reference is already owned by another build",
            retryable: false,
          });
        }
        try {
          const digests = await this.readBuildDigests(paths.metadata, paths.iid);
          this.assertInspection(existing, candidateLabels, reference, digests.imageId);
          const recovered: BuildResultMarkerV1 = {
            attempt: actualAttempt,
            cacheHitCount: 0,
            cacheMissCount: 0,
            contextSha256: command.context.contextSha256,
            contractVersion: 1,
            deploymentId: command.identity.deploymentId,
            dockerfileSha256: command.context.dockerfileSha256,
            imageDigest: digests.imageDigest,
            imageId: digests.imageId,
            imageReference: reference,
            organizationId: command.identity.organizationId,
            platform: this.platform,
            projectId: command.identity.projectId,
            sizeBytes: existing.sizeBytes,
            sourceRevision: command.identity.sourceRevision,
            treeRevision: command.identity.treeRevision,
            workItemId: command.identity.workItemId,
          };
          await this.writeMarker(paths.marker, recovered);
          return markerToBuiltImage(recovered, true);
        } catch (error) {
          if (error instanceof ImageBuildError && error.code !== "image_metadata_invalid") {
            throw error;
          }
          await this.removeExactImage(reference, existing, candidateLabels, root, signal);
        }
      }

      await Promise.all(
        [paths.marker, paths.metadata, paths.iid].map(async (path) => {
          try {
            await unlink(path);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
              throw error;
            }
          }
        }),
      );
      const snapshot = await createPrivateBuildContextSnapshot({
        context: command.context,
        limits: this.contextLimits,
        rootDirectory: root,
        signal,
        workItemId: command.identity.workItemId,
      });
      stageDirectory = snapshot.stageDirectory;
      await mkdir(join(stageDirectory, "home"), { mode: 0o700 });
      const labels = createBuildLabels(command, this.platform);
      builtLabels = labels;
      const progress = new BuildProgressConsumer({
        additionalRedactions: this.additionalRedactions,
        maxChunkBytes: this.limits.maxLogChunkBytes,
        maxRetainedBytes: this.limits.maxLogBytes,
        sink,
      });
      const arguments_: string[] = [
        "buildx",
        "build",
        "--builder",
        this.builderName,
        "--file",
        snapshot.dockerfilePath,
        "--iidfile",
        paths.iid,
        "--label",
      ];
      const labelEntries = Object.entries(labels).sort(([left], [right]) =>
        left.localeCompare(right),
      );
      for (let index = 0; index < labelEntries.length; index += 1) {
        const entry = labelEntries[index];
        if (entry === undefined) {
          continue;
        }
        if (index > 0) {
          arguments_.push("--label");
        }
        arguments_.push(`${entry[0]}=${entry[1]}`);
      }
      arguments_.push(
        "--load",
        "--metadata-file",
        paths.metadata,
        "--network=none",
        `--resource=memory=${this.limits.memoryMegabytes}m`,
        `--resource=memory-swap=${this.limits.memoryMegabytes}m`,
        "--resource=cpu-period=100000",
        `--resource=cpu-quota=${this.limits.cpuMillicores * 100}`,
        `--platform=${this.platform}`,
        "--progress=rawjson",
        "--provenance=false",
        "--sbom=false",
        `--shm-size=${this.limits.sharedMemoryMegabytes}m`,
        "--tag",
        reference,
        "--ulimit",
        `nproc=${this.limits.processLimit}:${this.limits.processLimit}`,
        "--",
        snapshot.contextDirectory,
      );
      await this.executor.execute({
        arguments: arguments_,
        binary: this.dockerBinary,
        cwd: stageDirectory,
        environment: this.environment(join(stageDirectory, "home")),
        maxLineBytes: this.limits.maxProgressLineBytes,
        maxOutputBytes: this.limits.maxProgressBytes,
        onLine: (line, stream) => progress.consumeLine(line, stream),
        retainOutput: false,
        signal,
      });
      const digests = await this.readBuildDigests(paths.metadata, paths.iid);
      const inspection = await this.executeInspect(reference, stageDirectory, signal);
      if (inspection === undefined) {
        throw buildError({
          code: "image_metadata_invalid",
          failureCategory: "internal_invariant_violation",
          message: "BuildKit reported success without loading the requested image",
          retryable: false,
        });
      }
      builtInspection = inspection;
      this.assertInspection(inspection, labels, reference, digests.imageId);
      const markerValue: BuildResultMarkerV1 = {
        attempt: command.attempt,
        cacheHitCount: progress.cacheHitCount,
        cacheMissCount: progress.cacheMissCount,
        contextSha256: command.context.contextSha256,
        contractVersion: 1,
        deploymentId: command.identity.deploymentId,
        dockerfileSha256: command.context.dockerfileSha256,
        imageDigest: digests.imageDigest,
        imageId: digests.imageId,
        imageReference: reference,
        organizationId: command.identity.organizationId,
        platform: this.platform,
        projectId: command.identity.projectId,
        sizeBytes: inspection.sizeBytes,
        sourceRevision: command.identity.sourceRevision,
        treeRevision: command.identity.treeRevision,
        workItemId: command.identity.workItemId,
      };
      await this.writeMarker(paths.marker, markerValue);
      return markerToBuiltImage(markerValue, false);
    } catch (error) {
      if (builtInspection !== undefined && builtLabels !== undefined && !signal.aborted) {
        try {
          await this.removeExactImage(
            createStableImageReference(command.identity),
            builtInspection,
            builtLabels,
            this.buildRootDirectory,
            signal,
          );
        } catch {
          // The original build failure remains authoritative; exact cleanup is retried later.
        }
      }
      return this.mapBuildFailure(error, command.signal, timeoutController.signal);
    } finally {
      clearTimeout(timeout);
      if (stageDirectory !== undefined) {
        await removePrivateBuildContextSnapshot(stageDirectory);
      }
    }
  }

  public async remove(command: RemoveBuiltImageCommand): Promise<void> {
    validateBuildIdentity(command.identity);
    if (command.signal.aborted) {
      throw command.signal.reason ?? new DOMException("The operation was aborted", "AbortError");
    }
    try {
      await this.prepareDockerConfiguration();
      const root = await preparePrivateBuildRoot(this.buildRootDirectory);
      const paths = this.resultPaths(root, command.identity.workItemId);
      const marker = await this.readMarker(paths.marker);
      if (marker === undefined) {
        return;
      }
      const reference = createStableImageReference(command.identity);
      const context = {
        contextDirectory: root,
        contextSha256: marker.contextSha256,
        dockerfilePath: "Dockerfile",
        dockerfileResolvedPath: "Dockerfile",
        dockerfileSha256: marker.dockerfileSha256,
      };
      const buildCommand: BuildImageCommand = {
        attempt: marker.attempt,
        context,
        identity: command.identity,
        signal: command.signal,
      };
      if (!markerMatchesCommand(marker, buildCommand, reference, this.platform)) {
        throw buildError({
          code: "image_cleanup_failed",
          failureCategory: "cleanup_failed",
          message: "The retained image record does not match the cleanup request",
          retryable: false,
        });
      }
      const inspection = await this.executeInspect(reference, root, command.signal);
      if (inspection !== undefined) {
        await this.removeExactImage(
          reference,
          inspection,
          createBuildLabels(buildCommand, this.platform, marker.attempt),
          root,
          command.signal,
        );
      }
      await Promise.all(
        [paths.marker, paths.metadata, paths.iid].map((path) =>
          rm(path, { force: true, recursive: false }),
        ),
      );
    } catch (error) {
      if (command.signal.aborted) {
        throw command.signal.reason ?? error;
      }
      if (error instanceof ImageBuildError) {
        throw error;
      }
      throw buildError({
        code: "image_cleanup_failed",
        failureCategory: "cleanup_failed",
        message: "The deployment image could not be removed safely",
        retryable: true,
      });
    }
  }
}
