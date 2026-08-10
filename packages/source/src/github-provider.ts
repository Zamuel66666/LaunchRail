import {
  type RepositoryProvider,
  type RepositoryTreeEntry,
  type ResolveRepositoryRevisionCommand,
  type ResolvedRepositoryRevision,
} from "@launchrail/application";

import {
  invalidSource,
  sourceCheckoutDefaultLimits,
  type SourceCheckoutLimits,
  unavailableSource,
  validateLimits,
  validatePublicGitHubRepository,
  validateRevision,
  validateSha,
  validateTreeEntries,
} from "./policy.js";

type FetchImplementation = (
  input: string | URL | globalThis.Request,
  init?: RequestInit,
) => Promise<Response>;

export interface GitHubRepositoryProviderOptions {
  readonly fetchImplementation?: FetchImplementation;
  readonly limits?: SourceCheckoutLimits;
  readonly timeoutMs?: number;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) {
    throw invalidSource("source_integrity_failed");
  }
  return value;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string") {
    throw invalidSource("source_integrity_failed");
  }
  return value;
}

export class GitHubRepositoryProvider implements RepositoryProvider {
  private readonly fetchImplementation: FetchImplementation;
  private readonly limits: SourceCheckoutLimits;
  private readonly timeoutMs: number;

  public constructor({
    fetchImplementation = globalThis.fetch,
    limits = sourceCheckoutDefaultLimits,
    timeoutMs = 15_000,
  }: GitHubRepositoryProviderOptions = {}) {
    validateLimits(limits);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error("Repository resolution timeout must be a positive integer");
    }
    this.fetchImplementation = fetchImplementation;
    this.limits = limits;
    this.timeoutMs = timeoutMs;
  }

  private async requestJson(url: URL, signal: AbortSignal): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImplementation(url, {
        cache: "no-store",
        credentials: "omit",
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "LaunchRail-source-adapter/0.1",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        method: "GET",
        redirect: "error",
        signal,
      });
    } catch (error) {
      if (signal.aborted) {
        throw signal.reason ?? error;
      }
      throw unavailableSource();
    }

    if (response.status === 404) {
      throw invalidSource("repository_invalid", "Repository or revision is unavailable");
    }
    if (response.status === 403 || response.status === 429 || response.status >= 500) {
      throw unavailableSource();
    }
    if (!response.ok) {
      throw invalidSource("repository_invalid", "Repository or revision is unavailable");
    }

    const contentLength = response.headers.get("content-length");
    if (contentLength !== null) {
      const parsedLength = Number(contentLength);
      if (!Number.isSafeInteger(parsedLength) || parsedLength > this.limits.maxApiResponseBytes) {
        throw invalidSource("source_limit_exceeded", "Repository exceeds source safety limits");
      }
    }
    if (response.body === null) {
      throw unavailableSource();
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    while (true) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch (error) {
        if (signal.aborted) {
          throw signal.reason ?? error;
        }
        throw unavailableSource();
      }
      if (result.done) {
        break;
      }
      byteLength += result.value.byteLength;
      if (byteLength > this.limits.maxApiResponseBytes) {
        await reader.cancel();
        throw invalidSource("source_limit_exceeded", "Repository exceeds source safety limits");
      }
      chunks.push(result.value);
    }

    try {
      return JSON.parse(Buffer.concat(chunks, byteLength).toString("utf8")) as unknown;
    } catch {
      throw invalidSource("source_integrity_failed");
    }
  }

  private parseTree(value: unknown, expectedTreeSha: string): readonly RepositoryTreeEntry[] {
    const body = requiredRecord(value);
    if (body.truncated !== false || body.sha !== expectedTreeSha || !Array.isArray(body.tree)) {
      throw invalidSource("source_integrity_failed");
    }

    const entries = body.tree.map((rawEntry): RepositoryTreeEntry => {
      const entry = requiredRecord(rawEntry);
      const mode = requiredString(entry.mode);
      const path = requiredString(entry.path);
      const sha = requiredString(entry.sha);
      const type = requiredString(entry.type);
      validateSha(sha);

      if (type === "tree" && mode === "040000") {
        return { mode, path, sha, size: 0, type };
      }
      if (
        type === "blob" &&
        (mode === "100644" || mode === "100755" || mode === "120000") &&
        typeof entry.size === "number"
      ) {
        return { mode, path, sha, size: entry.size, type };
      }
      throw invalidSource("source_integrity_failed");
    });
    const sortedEntries = entries.toSorted((left, right) => left.path.localeCompare(right.path));
    validateTreeEntries(sortedEntries, this.limits);
    return sortedEntries;
  }

  public async resolveRevision({
    repository,
    revision,
    signal,
  }: ResolveRepositoryRevisionCommand): Promise<ResolvedRepositoryRevision> {
    if (signal.aborted) {
      throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
    }
    validatePublicGitHubRepository(repository);
    validateRevision(revision);

    const timeoutController = new AbortController();
    const timeout = setTimeout(
      () => timeoutController.abort(new Error("Resolution timed out")),
      this.timeoutMs,
    );
    timeout.unref();
    const effectiveSignal = AbortSignal.any([signal, timeoutController.signal]);
    try {
      const encodedOwner = encodeURIComponent(repository.owner);
      const encodedRepository = encodeURIComponent(repository.repository);
      const base = `https://api.github.com/repos/${encodedOwner}/${encodedRepository}`;
      const repositoryResponse = requiredRecord(
        await this.requestJson(new URL(base), effectiveSignal),
      );
      if (
        repositoryResponse.private !== false ||
        repositoryResponse.visibility !== "public" ||
        typeof repositoryResponse.full_name !== "string" ||
        repositoryResponse.full_name.toLowerCase() !==
          `${repository.owner}/${repository.repository}`.toLowerCase()
      ) {
        throw invalidSource("repository_invalid", "Repository or revision is unavailable");
      }

      const commitResponse = requiredRecord(
        await this.requestJson(
          new URL(`${base}/commits/${encodeURIComponent(revision)}`),
          effectiveSignal,
        ),
      );
      const commitSha = requiredString(commitResponse.sha);
      const commitDetails = requiredRecord(commitResponse.commit);
      const tree = requiredRecord(commitDetails.tree);
      const treeSha = requiredString(tree.sha);
      validateSha(commitSha);
      validateSha(treeSha);

      const entries = this.parseTree(
        await this.requestJson(
          new URL(`${base}/git/trees/${treeSha}?recursive=1`),
          effectiveSignal,
        ),
        treeSha,
      );

      return {
        canonicalRepositoryUrl: `https://github.com/${repository.owner}/${repository.repository}`,
        commitSha,
        entries,
        owner: repository.owner,
        provider: "github",
        repository: repository.repository,
        requestedRevision: revision,
        treeSha,
      };
    } catch (error) {
      if (signal.aborted) {
        throw signal.reason ?? error;
      }
      if (timeoutController.signal.aborted) {
        throw unavailableSource();
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
