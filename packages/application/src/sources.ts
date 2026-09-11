import type { DeploymentFailureCategory } from "@launchrail/domain";

export interface PublicGitHubRepository {
  readonly owner: string;
  readonly repository: string;
}

export interface RepositoryTreeEntry {
  readonly mode: "040000" | "100644" | "100755" | "120000";
  readonly path: string;
  readonly sha: string;
  readonly size: number;
  readonly type: "blob" | "tree";
}

export interface ResolveRepositoryRevisionCommand {
  readonly repository: PublicGitHubRepository;
  readonly revision: string;
  readonly signal: AbortSignal;
}

export interface ResolvedRepositoryRevision extends PublicGitHubRepository {
  readonly canonicalRepositoryUrl: string;
  readonly commitSha: string;
  readonly entries: readonly RepositoryTreeEntry[];
  readonly provider: "github";
  readonly requestedRevision: string;
  readonly treeSha: string;
}

export interface DeploymentSourceSnapshotV1 {
  readonly contractVersion: 1;
  readonly dockerfilePath: string;
  readonly repositoryName: string;
  readonly repositoryOwner: string;
  readonly repositoryProvider: "github";
  readonly requestedRevision: string;
}

export interface DeploymentSourcePersistenceV1 {
  readonly sourceRevision: string;
  readonly sourceSnapshot: DeploymentSourceSnapshotV1;
}

export interface RepositoryProvider {
  resolveRevision(command: ResolveRepositoryRevisionCommand): Promise<ResolvedRepositoryRevision>;
}

export interface PreparedDockerfile {
  readonly relativePath: string;
  readonly resolvedRelativePath: string;
  readonly sha256: string;
  readonly size: number;
}

export interface PreparedRepositoryCheckout {
  readonly adopted: boolean;
  readonly checkoutKey: string;
  readonly commitSha: string;
  readonly contextSha256: string;
  readonly directory: string;
  readonly dockerfile: PreparedDockerfile;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly treeSha: string;
}

export interface CheckoutRepositoryCommand {
  readonly checkoutKey: string;
  readonly dockerfilePath: string;
  readonly resolvedRevision: ResolvedRepositoryRevision;
  readonly signal: AbortSignal;
}

export interface RepositoryCheckout {
  prepare(command: CheckoutRepositoryCommand): Promise<PreparedRepositoryCheckout>;
  remove(checkoutKey: string): Promise<void>;
}

export const sourcePreparationErrorCodes = [
  "repository_invalid",
  "repository_unavailable",
  "revision_invalid",
  "source_limit_exceeded",
  "source_integrity_failed",
  "checkout_failed",
  "checkout_timeout",
  "dockerfile_missing",
  "dockerfile_unsafe",
] as const;

export type SourcePreparationErrorCode = (typeof sourcePreparationErrorCodes)[number];

export class SourcePreparationError extends Error {
  public readonly code: SourcePreparationErrorCode;
  public readonly failureCategory: DeploymentFailureCategory;
  public readonly retryable: boolean;

  public constructor(options: {
    readonly code: SourcePreparationErrorCode;
    readonly failureCategory: DeploymentFailureCategory;
    readonly message: string;
    readonly retryable: boolean;
  }) {
    super(options.message);
    this.name = "SourcePreparationError";
    this.code = options.code;
    this.failureCategory = options.failureCategory;
    this.retryable = options.retryable;
  }
}

function assertPersistenceDockerfilePath(dockerfilePath: string): void {
  const segments = dockerfilePath.split("/");
  if (
    dockerfilePath.length === 0 ||
    dockerfilePath.length > 256 ||
    dockerfilePath.startsWith("/") ||
    !/^[A-Za-z0-9._/-]+$/.test(dockerfilePath) ||
    dockerfilePath.includes("\\") ||
    dockerfilePath.includes("%") ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new SourcePreparationError({
      code: "dockerfile_unsafe",
      failureCategory: "source_invalid",
      message: "The configured Dockerfile path is unsafe",
      retryable: false,
    });
  }
}

export function createDeploymentSourcePersistence(
  resolvedRevision: ResolvedRepositoryRevision,
  dockerfilePath: string,
): DeploymentSourcePersistenceV1 {
  assertPersistenceDockerfilePath(dockerfilePath);
  if (!/^[0-9a-f]{40}$/.test(resolvedRevision.commitSha)) {
    throw new SourcePreparationError({
      code: "source_integrity_failed",
      failureCategory: "source_invalid",
      message: "Repository source integrity validation failed",
      retryable: false,
    });
  }
  return {
    sourceRevision: resolvedRevision.commitSha,
    sourceSnapshot: {
      contractVersion: 1,
      dockerfilePath,
      repositoryName: resolvedRevision.repository,
      repositoryOwner: resolvedRevision.owner,
      repositoryProvider: "github",
      requestedRevision: resolvedRevision.requestedRevision,
    },
  };
}

export interface PrepareRepositoryCommand {
  readonly checkoutKey: string;
  readonly dockerfilePath: string;
  readonly repository: PublicGitHubRepository;
  readonly revision: string;
  readonly signal: AbortSignal;
}

export interface PrepareRepositoryOptions {
  readonly checkout: RepositoryCheckout;
  readonly provider: RepositoryProvider;
  readonly timeoutMs: number;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

export class PrepareRepository {
  private readonly checkout: RepositoryCheckout;
  private readonly provider: RepositoryProvider;
  private readonly timeoutMs: number;

  public constructor({ checkout, provider, timeoutMs }: PrepareRepositoryOptions) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error("Repository preparation timeout must be a positive integer");
    }
    this.checkout = checkout;
    this.provider = provider;
    this.timeoutMs = timeoutMs;
  }

  public async execute(command: PrepareRepositoryCommand): Promise<PreparedRepositoryCheckout> {
    if (command.signal.aborted) {
      throw abortReason(command.signal);
    }

    const timeoutController = new AbortController();
    const timeout = setTimeout(() => {
      timeoutController.abort(new Error("Repository preparation timed out"));
    }, this.timeoutMs);
    const signal = AbortSignal.any([command.signal, timeoutController.signal]);

    try {
      const resolvedRevision = await this.provider.resolveRevision({
        repository: command.repository,
        revision: command.revision,
        signal,
      });
      return await this.checkout.prepare({
        checkoutKey: command.checkoutKey,
        dockerfilePath: command.dockerfilePath,
        resolvedRevision,
        signal,
      });
    } catch (error) {
      if (command.signal.aborted) {
        throw abortReason(command.signal);
      }
      if (timeoutController.signal.aborted) {
        throw new SourcePreparationError({
          code: "checkout_timeout",
          failureCategory: "clone_timeout",
          message: "Repository preparation exceeded its time limit",
          retryable: true,
        });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
