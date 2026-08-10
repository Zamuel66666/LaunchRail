import {
  SourcePreparationError,
  type PublicGitHubRepository,
  type RepositoryTreeEntry,
} from "@launchrail/application";

export interface SourceCheckoutLimits {
  readonly maxApiResponseBytes: number;
  readonly maxFileBytes: number;
  readonly maxFileCount: number;
  readonly maxGitDirectoryBytes: number;
  readonly maxPathBytes: number;
  readonly maxProcessOutputBytes: number;
  readonly maxTotalBytes: number;
  readonly maxTreeDepth: number;
}

export const sourceCheckoutDefaultLimits: SourceCheckoutLimits = {
  maxApiResponseBytes: 8 * 1024 * 1024,
  maxFileBytes: 16 * 1024 * 1024,
  maxFileCount: 10_000,
  maxGitDirectoryBytes: 160 * 1024 * 1024,
  maxPathBytes: 1_024,
  maxProcessOutputBytes: 64 * 1024,
  maxTotalBytes: 100 * 1024 * 1024,
  maxTreeDepth: 64,
};

const ownerPattern = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;
const repositoryPattern = /^[a-z0-9._-]{1,100}$/;
const revisionPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;
const checkoutKeyPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const shaPattern = /^[0-9a-f]{40}$/;
const controlCharacterPattern = /[\u0000-\u001f\u007f]/;

export function invalidSource(
  code:
    "repository_invalid" | "revision_invalid" | "source_integrity_failed" | "source_limit_exceeded",
  message = "Repository source is invalid or unsupported",
): SourcePreparationError {
  return new SourcePreparationError({
    code,
    failureCategory: "source_invalid",
    message,
    retryable: false,
  });
}

export function unavailableSource(): SourcePreparationError {
  return new SourcePreparationError({
    code: "repository_unavailable",
    failureCategory: "source_unavailable",
    message: "The public repository provider is temporarily unavailable",
    retryable: true,
  });
}

export function validateLimits(limits: SourceCheckoutLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Source checkout limit ${name} must be a positive integer`);
    }
  }
  if (limits.maxFileBytes > limits.maxTotalBytes) {
    throw new Error("Source checkout maxFileBytes cannot exceed maxTotalBytes");
  }
}

export function validatePublicGitHubRepository(repository: PublicGitHubRepository): void {
  if (
    !ownerPattern.test(repository.owner) ||
    repository.owner.includes("--") ||
    !repositoryPattern.test(repository.repository) ||
    repository.repository === "." ||
    repository.repository === ".." ||
    repository.repository.endsWith(".git")
  ) {
    throw invalidSource("repository_invalid", "Repository or revision is unavailable");
  }
}

export function validateRevision(revision: string): void {
  const segments = revision.split("/");
  if (
    !revisionPattern.test(revision) ||
    revision.includes("..") ||
    revision.includes("//") ||
    revision.endsWith(".") ||
    revision === "@" ||
    segments.some(
      (segment) => segment.length === 0 || segment.startsWith(".") || segment.endsWith(".lock"),
    )
  ) {
    throw invalidSource("revision_invalid", "Repository or revision is unavailable");
  }
}

export function validateCheckoutKey(checkoutKey: string): void {
  if (!checkoutKeyPattern.test(checkoutKey)) {
    throw invalidSource("source_integrity_failed");
  }
}

export function validateDockerfilePath(dockerfilePath: string): void {
  const segments = dockerfilePath.split("/");
  if (
    dockerfilePath.length === 0 ||
    dockerfilePath.length > 256 ||
    dockerfilePath.startsWith("/") ||
    !/^[A-Za-z0-9._/-]+$/.test(dockerfilePath) ||
    dockerfilePath.includes("\\") ||
    dockerfilePath.includes("%") ||
    controlCharacterPattern.test(dockerfilePath) ||
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

export function validateSha(value: string): void {
  if (!shaPattern.test(value)) {
    throw invalidSource("source_integrity_failed");
  }
}

export function validateTreeEntries(
  entries: readonly RepositoryTreeEntry[],
  limits: SourceCheckoutLimits,
): { readonly fileCount: number; readonly totalBytes: number } {
  if (entries.length > limits.maxFileCount) {
    throw invalidSource("source_limit_exceeded", "Repository exceeds source safety limits");
  }

  const paths = new Set<string>();
  let fileCount = 0;
  let totalBytes = 0;
  for (const entry of entries) {
    validateSha(entry.sha);
    if (paths.has(entry.path)) {
      throw invalidSource("source_integrity_failed");
    }
    paths.add(entry.path);

    const segments = entry.path.split("/");
    if (
      entry.path.length === 0 ||
      entry.path.startsWith("/") ||
      Buffer.byteLength(entry.path, "utf8") > limits.maxPathBytes ||
      segments.length > limits.maxTreeDepth ||
      controlCharacterPattern.test(entry.path) ||
      entry.path.includes("\\") ||
      segments.some(
        (segment) =>
          segment.length === 0 ||
          segment === "." ||
          segment === ".." ||
          segment.toLowerCase() === ".git",
      )
    ) {
      throw invalidSource("source_integrity_failed");
    }

    if (entry.type === "tree") {
      if (entry.mode !== "040000" || entry.size !== 0) {
        throw invalidSource("source_integrity_failed");
      }
      continue;
    }

    if (!["100644", "100755", "120000"].includes(entry.mode)) {
      throw invalidSource("source_integrity_failed");
    }
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > limits.maxFileBytes) {
      throw invalidSource("source_limit_exceeded", "Repository exceeds source safety limits");
    }
    fileCount += 1;
    totalBytes += entry.size;
    if (fileCount > limits.maxFileCount || totalBytes > limits.maxTotalBytes) {
      throw invalidSource("source_limit_exceeded", "Repository exceeds source safety limits");
    }
  }

  return { fileCount, totalBytes };
}
