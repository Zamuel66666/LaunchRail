import { describe, expect, it, vi } from "vitest";

import { SourcePreparationError } from "@launchrail/application";

import { GitHubRepositoryProvider, sourceCheckoutDefaultLimits } from "../src/index.js";

const commitSha = "a".repeat(40);
const treeSha = "b".repeat(40);
const blobSha = "c".repeat(40);

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status,
  });
}

function successfulFetch() {
  const calls: Array<{ readonly init: RequestInit | undefined; readonly url: string }> = [];
  const implementation = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ init, url });
    if (url.includes("/commits/")) {
      return jsonResponse({ commit: { tree: { sha: treeSha } }, sha: commitSha });
    }
    if (url.includes("/git/trees/")) {
      return jsonResponse({
        sha: treeSha,
        tree: [{ mode: "100644", path: "Dockerfile", sha: blobSha, size: 12, type: "blob" }],
        truncated: false,
      });
    }
    return jsonResponse({
      full_name: "launchrail/example",
      private: false,
      visibility: "public",
    });
  });
  return { calls, implementation };
}

describe("GitHubRepositoryProvider", () => {
  it.each(["main", commitSha, "release/v1.0"])(
    "resolves %s to an exact commit and tree through fixed GitHub endpoints",
    async (revision) => {
      const fake = successfulFetch();
      const provider = new GitHubRepositoryProvider({ fetchImplementation: fake.implementation });

      await expect(
        provider.resolveRevision({
          repository: { owner: "launchrail", repository: "example" },
          revision,
          signal: new AbortController().signal,
        }),
      ).resolves.toEqual({
        canonicalRepositoryUrl: "https://github.com/launchrail/example",
        commitSha,
        entries: [{ mode: "100644", path: "Dockerfile", sha: blobSha, size: 12, type: "blob" }],
        owner: "launchrail",
        provider: "github",
        repository: "example",
        requestedRevision: revision,
        treeSha,
      });

      expect(fake.calls).toHaveLength(3);
      expect(fake.calls.every(({ url }) => new URL(url).origin === "https://api.github.com")).toBe(
        true,
      );
      expect(fake.calls[1]?.url).toContain(`/commits/${encodeURIComponent(revision)}`);
      for (const { init } of fake.calls) {
        expect(init).toMatchObject({ credentials: "omit", method: "GET", redirect: "error" });
        expect(new Headers(init?.headers).has("authorization")).toBe(false);
      }
    },
  );

  it("rejects private or renamed repository metadata without resolving a revision", async () => {
    const implementation = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ full_name: "other/example", private: true, visibility: "private" }),
      );
    const provider = new GitHubRepositoryProvider({ fetchImplementation: implementation });

    await expect(
      provider.resolveRevision({
        repository: { owner: "launchrail", repository: "example" },
        revision: "main",
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      code: "repository_invalid",
      failureCategory: "source_invalid",
      retryable: false,
    });
    expect(implementation).toHaveBeenCalledTimes(1);
  });

  it.each([
    [404, "repository_invalid", false],
    [302, "repository_invalid", false],
    [403, "repository_unavailable", true],
    [429, "repository_unavailable", true],
    [503, "repository_unavailable", true],
  ] as const)(
    "classifies HTTP %s without exposing a response body",
    async (status, code, retryable) => {
      const canary = "credential-canary";
      const provider = new GitHubRepositoryProvider({
        fetchImplementation: vi
          .fn()
          .mockResolvedValue(new Response(canary, { status, statusText: canary })),
      });

      try {
        await provider.resolveRevision({
          repository: { owner: "launchrail", repository: "example" },
          revision: "main",
          signal: new AbortController().signal,
        });
        throw new Error("Expected resolution to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(SourcePreparationError);
        expect(error).toMatchObject({ code, retryable });
        expect((error as Error).message).not.toContain(canary);
      }
    },
  );

  it("classifies a malformed successful payload as an integrity failure", async () => {
    const provider = new GitHubRepositoryProvider({
      fetchImplementation: vi.fn().mockResolvedValue(new Response("not-json", { status: 200 })),
    });

    await expect(
      provider.resolveRevision({
        repository: { owner: "launchrail", repository: "example" },
        revision: "main",
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "source_integrity_failed", retryable: false });
  });

  it("bounds streamed bodies even when content-length is absent", async () => {
    const limits = { ...sourceCheckoutDefaultLimits, maxApiResponseBytes: 32 };
    const provider = new GitHubRepositoryProvider({
      fetchImplementation: vi.fn().mockResolvedValue(new Response("x".repeat(33))),
      limits,
    });

    await expect(
      provider.resolveRevision({
        repository: { owner: "launchrail", repository: "example" },
        revision: "main",
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "source_limit_exceeded", retryable: false });
  });

  it.each([
    {
      sha: treeSha,
      tree: [{ mode: "160000", path: "submodule", sha: blobSha, type: "commit" }],
      truncated: false,
    },
    {
      sha: treeSha,
      tree: [{ mode: "100644", path: "../escape", sha: blobSha, size: 1, type: "blob" }],
      truncated: false,
    },
    { sha: treeSha, tree: [], truncated: true },
  ])("rejects malicious or incomplete recursive tree metadata", async (treeResponse) => {
    const fake = successfulFetch();
    fake.implementation.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/git/trees/")) {
        return jsonResponse(treeResponse);
      }
      if (url.includes("/commits/")) {
        return jsonResponse({ commit: { tree: { sha: treeSha } }, sha: commitSha });
      }
      return jsonResponse({
        full_name: "launchrail/example",
        private: false,
        visibility: "public",
      });
    });
    const provider = new GitHubRepositoryProvider({ fetchImplementation: fake.implementation });

    await expect(
      provider.resolveRevision({
        repository: { owner: "launchrail", repository: "example" },
        revision: "main",
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "source_integrity_failed", retryable: false });
  });

  it("enforces one resolver deadline and preserves caller cancellation", async () => {
    vi.useFakeTimers();
    try {
      const implementation = vi.fn(
        async (_input: string | URL | Request, init?: RequestInit): Promise<Response> =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
              once: true,
            });
          }),
      );
      const provider = new GitHubRepositoryProvider({
        fetchImplementation: implementation,
        timeoutMs: 100,
      });
      const operation = provider.resolveRevision({
        repository: { owner: "launchrail", repository: "example" },
        revision: "main",
        signal: new AbortController().signal,
      });
      const timeoutAssertion = expect(operation).rejects.toMatchObject({
        code: "repository_unavailable",
        retryable: true,
      });
      await vi.advanceTimersByTimeAsync(100);
      await timeoutAssertion;

      const caller = new AbortController();
      const cancelled = provider.resolveRevision({
        repository: { owner: "launchrail", repository: "example" },
        revision: "main",
        signal: caller.signal,
      });
      const reason = new Error("shutdown");
      caller.abort(reason);
      await expect(cancelled).rejects.toBe(reason);
    } finally {
      vi.useRealTimers();
    }
  });
});
