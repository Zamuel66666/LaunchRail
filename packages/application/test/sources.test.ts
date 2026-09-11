import { describe, expect, it, vi } from "vitest";

import {
  PrepareRepository,
  SourcePreparationError,
  createDeploymentSourcePersistence,
  type PreparedRepositoryCheckout,
  type RepositoryCheckout,
  type RepositoryProvider,
  type ResolvedRepositoryRevision,
} from "../src/index.js";

const resolvedRevision: ResolvedRepositoryRevision = {
  canonicalRepositoryUrl: "https://github.com/launchrail/example",
  commitSha: "a".repeat(40),
  entries: [],
  owner: "launchrail",
  provider: "github",
  repository: "example",
  requestedRevision: "main",
  treeSha: "b".repeat(40),
};

const preparedCheckout: PreparedRepositoryCheckout = {
  adopted: false,
  checkoutKey: "deployment-1",
  commitSha: resolvedRevision.commitSha,
  contextSha256: "d".repeat(64),
  directory: "/safe/deployment-1/source",
  dockerfile: {
    relativePath: "Dockerfile",
    resolvedRelativePath: "Dockerfile",
    sha256: "c".repeat(64),
    size: 12,
  },
  fileCount: 1,
  totalBytes: 12,
  treeSha: resolvedRevision.treeSha,
};

function createPorts(): {
  checkout: RepositoryCheckout;
  provider: RepositoryProvider;
} {
  return {
    checkout: {
      prepare: vi.fn().mockResolvedValue(preparedCheckout),
      remove: vi.fn().mockResolvedValue(undefined),
    },
    provider: {
      resolveRevision: vi.fn().mockResolvedValue(resolvedRevision),
    },
  };
}

describe("PrepareRepository", () => {
  it("resolves and checks out through one shared cancellation signal", async () => {
    const ports = createPorts();
    const useCase = new PrepareRepository({ ...ports, timeoutMs: 1_000 });
    const caller = new AbortController();

    await expect(
      useCase.execute({
        checkoutKey: "deployment-1",
        dockerfilePath: "Dockerfile",
        repository: { owner: "launchrail", repository: "example" },
        revision: "main",
        signal: caller.signal,
      }),
    ).resolves.toEqual(preparedCheckout);

    const resolveCall = vi.mocked(ports.provider.resolveRevision).mock.calls[0]?.[0];
    const checkoutCall = vi.mocked(ports.checkout.prepare).mock.calls[0]?.[0];
    expect(resolveCall?.signal).toBe(checkoutCall?.signal);
    expect(checkoutCall?.resolvedRevision).toBe(resolvedRevision);
  });

  it("does not start checkout when resolution fails", async () => {
    const ports = createPorts();
    const failure = new SourcePreparationError({
      code: "repository_invalid",
      failureCategory: "source_invalid",
      message: "Repository or revision is unavailable",
      retryable: false,
    });
    vi.mocked(ports.provider.resolveRevision).mockRejectedValue(failure);
    const useCase = new PrepareRepository({ ...ports, timeoutMs: 1_000 });

    await expect(
      useCase.execute({
        checkoutKey: "deployment-1",
        dockerfilePath: "Dockerfile",
        repository: { owner: "launchrail", repository: "example" },
        revision: "main",
        signal: new AbortController().signal,
      }),
    ).rejects.toBe(failure);
    expect(ports.checkout.prepare).not.toHaveBeenCalled();
  });

  it("turns its absolute deadline into a safe retryable timeout", async () => {
    vi.useFakeTimers();
    try {
      const ports = createPorts();
      vi.mocked(ports.provider.resolveRevision).mockImplementation(
        ({ signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
      );
      const useCase = new PrepareRepository({ ...ports, timeoutMs: 100 });
      const operation = useCase.execute({
        checkoutKey: "deployment-1",
        dockerfilePath: "Dockerfile",
        repository: { owner: "launchrail", repository: "example" },
        revision: "main",
        signal: new AbortController().signal,
      });
      const assertion = expect(operation).rejects.toMatchObject({
        code: "checkout_timeout",
        failureCategory: "clone_timeout",
        retryable: true,
      });

      await vi.advanceTimersByTimeAsync(100);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves caller cancellation instead of recording a source failure", async () => {
    const ports = createPorts();
    vi.mocked(ports.provider.resolveRevision).mockImplementation(
      ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    const useCase = new PrepareRepository({ ...ports, timeoutMs: 1_000 });
    const caller = new AbortController();
    const operation = useCase.execute({
      checkoutKey: "deployment-1",
      dockerfilePath: "Dockerfile",
      repository: { owner: "launchrail", repository: "example" },
      revision: "main",
      signal: caller.signal,
    });
    const reason = new Error("worker shutdown");
    caller.abort(reason);

    await expect(operation).rejects.toBe(reason);
  });

  it("rejects a non-positive timeout at composition time", () => {
    const ports = createPorts();
    expect(() => new PrepareRepository({ ...ports, timeoutMs: 0 })).toThrow(
      "Repository preparation timeout must be a positive integer",
    );
  });
});

describe("deployment source persistence", () => {
  it("keeps the resolved SHA pinned separately from the typed source snapshot", () => {
    expect(createDeploymentSourcePersistence(resolvedRevision, "deploy/Dockerfile")).toEqual({
      sourceRevision: "a".repeat(40),
      sourceSnapshot: {
        contractVersion: 1,
        dockerfilePath: "deploy/Dockerfile",
        repositoryName: "example",
        repositoryOwner: "launchrail",
        repositoryProvider: "github",
        requestedRevision: "main",
      },
    });
  });

  it.each(["/Dockerfile", "../Dockerfile", "deploy//Dockerfile", "deploy\\Dockerfile"])(
    "rejects the unsafe persisted Dockerfile path %s",
    (dockerfilePath) => {
      expect(() => createDeploymentSourcePersistence(resolvedRevision, dockerfilePath)).toThrow(
        SourcePreparationError,
      );
    },
  );
});
