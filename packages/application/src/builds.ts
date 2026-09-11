import type { DeploymentFailureCategory } from "@launchrail/domain";

export const imageBuildErrorCodes = [
  "build_context_invalid",
  "build_context_changed",
  "build_output_limit_exceeded",
  "build_timeout",
  "buildkit_unavailable",
  "build_failed",
  "image_metadata_invalid",
  "image_cleanup_failed",
] as const;

export type ImageBuildErrorCode = (typeof imageBuildErrorCodes)[number];

export type BuildLogStream = "stderr" | "stdout" | "system";

export interface BuildLogChunk {
  readonly content: string;
  readonly stream: BuildLogStream;
}

export interface BuildLogSink {
  write(chunks: readonly BuildLogChunk[]): Promise<void>;
}

export interface DeploymentBuildIdentity {
  readonly deploymentId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly sourceRevision: string;
  readonly treeRevision: string;
  readonly workItemId: string;
}

export interface PreparedBuildContext {
  readonly contextDirectory: string;
  readonly contextSha256: string;
  readonly dockerfilePath: string;
  readonly dockerfileResolvedPath: string;
  readonly dockerfileSha256: string;
}

export interface BuildImageCommand {
  readonly attempt: number;
  readonly context: PreparedBuildContext;
  readonly identity: DeploymentBuildIdentity;
  readonly signal: AbortSignal;
}

export interface BuiltImage {
  readonly adopted: boolean;
  readonly cacheHitCount: number;
  readonly cacheMissCount: number;
  readonly imageDigest: string;
  readonly imageId: string;
  readonly imageReference: string;
  readonly platform: `linux/${string}`;
  readonly sizeBytes: number;
}

export interface RemoveBuiltImageCommand {
  readonly attempt: number;
  readonly identity: DeploymentBuildIdentity;
  readonly signal: AbortSignal;
}

export interface ImageBuilder {
  build(command: BuildImageCommand, sink: BuildLogSink): Promise<BuiltImage>;
  remove(command: RemoveBuiltImageCommand): Promise<void>;
}

export class ImageBuildError extends Error {
  public readonly code: ImageBuildErrorCode;
  public readonly failureCategory: DeploymentFailureCategory;
  public readonly retryable: boolean;

  public constructor(options: {
    readonly code: ImageBuildErrorCode;
    readonly failureCategory: DeploymentFailureCategory;
    readonly message: string;
    readonly retryable: boolean;
  }) {
    super(options.message);
    this.name = "ImageBuildError";
    this.code = options.code;
    this.failureCategory = options.failureCategory;
    this.retryable = options.retryable;
  }
}
