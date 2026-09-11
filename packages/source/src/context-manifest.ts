import { createHash } from "node:crypto";

export type RepositoryContextManifestEntry =
  | {
      readonly contentSha256: string;
      readonly kind: "directory";
      readonly mode: "040000";
      readonly path: string;
      readonly size: 0;
    }
  | {
      readonly contentSha256: string;
      readonly kind: "file";
      readonly mode: "100644" | "100755";
      readonly path: string;
      readonly size: number;
    }
  | {
      readonly contentSha256: string;
      readonly kind: "symlink";
      readonly mode: "120000";
      readonly path: string;
      readonly size: number;
    };

const sha256Pattern = /^[0-9a-f]{64}$/;
const emptyContentSha256 = createHash("sha256").digest("hex");

function assertManifestEntry(entry: RepositoryContextManifestEntry): Buffer {
  const segments = entry.path.split("/");
  if (
    entry.path.length === 0 ||
    entry.path.startsWith("/") ||
    entry.path.includes("\0") ||
    entry.path.includes("\\") ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new RangeError("Context manifest paths must be safe relative POSIX paths");
  }
  if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
    throw new RangeError("Context manifest sizes must be nonnegative safe integers");
  }
  if (!sha256Pattern.test(entry.contentSha256)) {
    throw new RangeError("Context manifest content digests must be lowercase SHA-256 values");
  }
  if (
    (entry.kind === "directory" &&
      (entry.mode !== "040000" ||
        entry.size !== 0 ||
        entry.contentSha256 !== emptyContentSha256)) ||
    (entry.kind === "file" && entry.mode !== "100644" && entry.mode !== "100755") ||
    (entry.kind === "symlink" && entry.mode !== "120000")
  ) {
    throw new RangeError("Context manifest kind, mode, and size do not agree");
  }
  return Buffer.from(entry.path, "utf8");
}

/**
 * Hashes a deterministic, versioned manifest rather than filesystem metadata.
 * Paths are ordered by raw UTF-8 bytes and every field is length-delimited or
 * NUL-delimited so distinct trees cannot share an ambiguous serialization.
 */
export function computeRepositoryContextSha256(
  entries: readonly RepositoryContextManifestEntry[],
): string {
  const prepared = entries.map((entry) => ({ entry, pathBytes: assertManifestEntry(entry) }));
  prepared.sort((left, right) => Buffer.compare(left.pathBytes, right.pathBytes));

  const hash = createHash("sha256").update("launchrail-context-manifest-v1\0", "utf8");
  let previousPath: Buffer | undefined;
  for (const { entry, pathBytes } of prepared) {
    if (previousPath !== undefined && Buffer.compare(previousPath, pathBytes) === 0) {
      throw new RangeError("Context manifest paths must be unique");
    }
    previousPath = pathBytes;
    hash.update(entry.kind, "utf8");
    hash.update("\0", "utf8");
    hash.update(entry.mode, "utf8");
    hash.update("\0", "utf8");
    hash.update(String(pathBytes.byteLength), "utf8");
    hash.update("\0", "utf8");
    hash.update(pathBytes);
    hash.update("\0", "utf8");
    hash.update(String(entry.size), "utf8");
    hash.update("\0", "utf8");
    hash.update(entry.contentSha256, "ascii");
    hash.update("\0", "utf8");
  }
  return hash.digest("hex");
}

export { emptyContentSha256 as repositoryContextEmptyContentSha256 };
