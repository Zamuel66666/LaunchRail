import type {
  DeploymentJobLease,
  DeploymentJobStore,
  PreparedRepositoryCheckout,
  RepositoryCheckout,
  RepositoryProvider,
  ResolvedRepositoryRevision,
} from "@launchrail/application";
import { PrepareRepository, SourcePreparationError } from "@launchrail/application";
import { describe, expect, it, vi } from "vitest";

import type { WorkerEventLogger } from "../src/processor.js";
import { DeploymentSourceProcessor } from "../src/source-processor.js";

const workItemId = "11111111-1111-4111-8111-111111111111";
const deploymentId = "22222222-2222-4222-8222-222222222222";
const organizationId = "33333333-3333-4333-8333-333333333333";
const leaseToken = "44444444-4444-4444-8444-444444444444";
const commitSha = "a".repeat(40);
const treeSha = "b".repeat(40);
const dockerfileSha256 = "c".repeat(64);
const now = new Date("2026-08-10T12:00:00.000Z");

const lease: DeploymentJobLease = {
  attemptCount: 1,
  deploymentId,
  kind: "deployment.prepare_source",
  leaseExpiresAt: new Date(now.getTime() + 60_000),
  leaseToken,
  organizationId,
  workItemId,
};

const resolvedRevision: ResolvedRepositoryRevision = {
  canonicalRepositoryUrl: "https://github.com/launchrail/example",
  commitSha,
  entries: [],
  owner: "launchrail",
  provider: "github",
  repository: "example",
  requestedRevision: commitSha,
  treeSha,
};

const preparedCheckout: PreparedRepositoryCheckout = {
  adopted: false,
  checkoutKey: deploymentId,
  commitSha,
  directory: `/worker/source/${deploymentId}`,
  dockerfile: {
    relativePath: "Dockerfile",
    resolvedRelativePath: "container/Dockerfile",
    sha256: dockerfileSha256,
    size: 128,
  },
  fileCount: 4,
  totalBytes: 1_024,
  treeSha,
};

const job = { contractVersion: 1, kind: "deployment.prepare_source", workItemId } as const;

function createLogger(): WorkerEventLogger & { readonly records: unknown[] } {
  const records: unknown[] = [];
  return {
    error: (bindings, message) => records.push({ bindings, message }),
    info: (bindings, message) => records.push({ bindings, message }),
    records,
    warn: (bindings, message) => records.push({ bindings, message }),
  };
}

function createStore(overrides: Partial<DeploymentJobStore> = {}): DeploymentJobStore {
  return {
    claim: vi.fn(async () => ({ kind: "claimed" as const, lease })),
    completeClaimTransition: vi.fn(async () => ({ kind: "not_found" as const })),
    completeSourcePreparation: vi.fn(async () => ({
      kind: "completed" as const,
      source: {
        checkoutId: deploymentId,
        deploymentId,
        dockerfilePath: "Dockerfile",
        dockerfileResolvedPath: "container/Dockerfile",
        dockerfileSha256,
        fileCount: 4,
        organizationId,
        preparedAt: now,
        resolvedRevision: commitSha,
        totalBytes: 1_024,
        treeRevision: treeSha,
      },
      transition: {
        deploymentId,
        eventSequence: 2,
        from: "cloning" as const,
        idempotentReplay: false,
        to: "building" as const,
        version: 3,
      },
    })),
    ensureMissing: vi.fn(async () => []),
    ensureMissingClaims: vi.fn(async () => []),
    ensurePendingClaim: vi.fn(async () => ({ kind: "deployment_not_found" as const })),
    fail: vi.fn(async () => ({ kind: "not_found" as const })),
    failSourcePreparation: vi.fn(async () => ({ kind: "not_found" as const })),
    heartbeat: vi.fn(async () => ({
      kind: "extended" as const,
      leaseExpiresAt: lease.leaseExpiresAt,
    })),
    listDispatchable: vi.fn(async () => []),
    listWorkerHeartbeats: vi.fn(async () => []),
    loadSourcePreparation: vi.fn(async () => ({
      kind: "loaded" as const,
      source: {
        deploymentId,
        dockerfilePath: "Dockerfile",
        organizationId,
        repositoryName: "example",
        repositoryOwner: "launchrail",
        repositoryProvider: "github" as const,
        requestedRevision: "main",
        resolvedRevision: commitSha,
        workItemId,
      },
    })),
    recordWorkerHeartbeat: vi.fn(async () => ({ kind: "version_mismatch" as const })),
    recoverExpired: vi.fn(async () => []),
    ...overrides,
  };
}

function createPreparation(
  options: {
    readonly checkout?: RepositoryCheckout;
    readonly provider?: RepositoryProvider;
    readonly timeoutMs?: number;
  } = {},
): PrepareRepository {
  return new PrepareRepository({
    checkout:
      options.checkout ??
      ({
        prepare: vi.fn(async () => preparedCheckout),
        remove: vi.fn(async () => undefined),
      } satisfies RepositoryCheckout),
    provider:
      options.provider ??
      ({ resolveRevision: vi.fn(async () => resolvedRevision) } satisfies RepositoryProvider),
    timeoutMs: options.timeoutMs ?? 1_000,
  });
}

function createProcessor(
  store: DeploymentJobStore,
  prepareRepository = createPreparation(),
  logger = createLogger(),
  jobTimeoutMs = 1_000,
): DeploymentSourceProcessor {
  return new DeploymentSourceProcessor({
    backoffBaseMs: 1_000,
    backoffCapMs: 60_000,
    heartbeatIntervalMs: 1_000,
    jobTimeoutMs,
    leaseDurationMs: 60_000,
    logger,
    prepareRepository,
    store,
    workerId: "worker-test",
  });
}

describe("DeploymentSourceProcessor", () => {
  it("prepares the immutable exact revision and persists only portable metadata", async () => {
    const completeSourcePreparation = vi.fn(createStore().completeSourcePreparation);
    const store = createStore({ completeSourcePreparation });
    const provider = {
      resolveRevision: vi.fn(async () => resolvedRevision),
    } satisfies RepositoryProvider;
    const checkout = {
      prepare: vi.fn(async () => preparedCheckout),
      remove: vi.fn(async () => undefined),
    } satisfies RepositoryCheckout;
    const processor = createProcessor(store, createPreparation({ checkout, provider }));

    await expect(processor.process(job, new AbortController().signal)).resolves.toBe("completed");

    expect(store.claim).toHaveBeenCalledWith({
      expectedKind: "deployment.prepare_source",
      leaseDurationMs: 60_000,
      workerId: "worker-test",
      workItemId,
    });
    expect(provider.resolveRevision).toHaveBeenCalledWith({
      repository: { owner: "launchrail", repository: "example" },
      revision: commitSha,
      signal: expect.any(AbortSignal),
    });
    expect(completeSourcePreparation).toHaveBeenCalledWith({
      leaseToken,
      metadata: {
        checkoutId: deploymentId,
        dockerfilePath: "Dockerfile",
        dockerfileResolvedPath: "container/Dockerfile",
        dockerfileSha256,
        fileCount: 4,
        resolvedRevision: commitSha,
        totalBytes: 1_024,
        treeRevision: treeSha,
      },
      workItemId,
    });
    expect(JSON.stringify(completeSourcePreparation.mock.calls)).not.toContain(
      preparedCheckout.directory,
    );
    expect(processor.getActiveJobCount()).toBe(0);
  });

  it("dead-letters a permanent source error with a fixed safe message", async () => {
    const canary = "provider-private-diagnostic";
    const logger = createLogger();
    const failSourcePreparation = vi.fn(async () => ({
      attemptCount: 1,
      kind: "dead_lettered" as const,
      transition: {
        deploymentId,
        eventSequence: 2,
        failure: {
          category: "dockerfile_missing" as const,
          message: "The configured Dockerfile was not found in the repository",
        },
        from: "cloning" as const,
        idempotentReplay: false,
        to: "build_failed" as const,
        version: 3,
      },
    }));
    const store = createStore({ failSourcePreparation });
    const checkout = {
      prepare: vi.fn(async () => {
        throw new SourcePreparationError({
          code: "dockerfile_missing",
          failureCategory: "dockerfile_missing",
          message: canary,
          retryable: false,
        });
      }),
      remove: vi.fn(async () => undefined),
    } satisfies RepositoryCheckout;
    const processor = createProcessor(store, createPreparation({ checkout }), logger);

    await expect(processor.process(job, new AbortController().signal)).resolves.toBe(
      "dead_lettered",
    );
    expect(failSourcePreparation).toHaveBeenCalledWith({
      failure: {
        category: "dockerfile_missing",
        message: "The configured Dockerfile was not found in the repository",
      },
      leaseToken,
      retryable: false,
      retryDelayMs: expect.any(Number),
      workItemId,
    });
    expect(JSON.stringify(logger.records)).not.toContain(canary);
    expect(JSON.stringify(failSourcePreparation.mock.calls)).not.toContain(canary);
  });

  it("retries an unexpected infrastructure error without persisting its diagnostic", async () => {
    const canary = "credential-helper-output";
    const logger = createLogger();
    const failSourcePreparation = vi.fn(async () => ({
      attemptCount: 1,
      availableAt: now,
      kind: "retry_scheduled" as const,
    }));
    const store = createStore({ failSourcePreparation });
    const provider = {
      resolveRevision: vi.fn(async () => {
        throw new Error(canary);
      }),
    } satisfies RepositoryProvider;
    const processor = createProcessor(store, createPreparation({ provider }), logger);

    await expect(processor.process(job, new AbortController().signal)).resolves.toBe(
      "retry_scheduled",
    );
    expect(failSourcePreparation).toHaveBeenCalledWith({
      failure: {
        category: "infrastructure_unavailable",
        message: "Repository preparation could not complete and is safe to retry",
      },
      leaseToken,
      retryable: true,
      retryDelayMs: expect.any(Number),
      workItemId,
    });
    expect(JSON.stringify(logger.records)).not.toContain(canary);
    expect(JSON.stringify(failSourcePreparation.mock.calls)).not.toContain(canary);
  });

  it("terminally rejects an unsupported immutable source snapshot before provider access", async () => {
    const failSourcePreparation = vi.fn(async () => ({
      attemptCount: 1,
      kind: "dead_lettered" as const,
      transition: {
        deploymentId,
        eventSequence: 2,
        failure: {
          category: "source_invalid" as const,
          message: "Deployment source metadata is invalid or unsupported",
        },
        from: "cloning" as const,
        idempotentReplay: false,
        to: "build_failed" as const,
        version: 3,
      },
    }));
    const store = createStore({
      failSourcePreparation,
      loadSourcePreparation: vi.fn(async () => ({
        kind: "invalid_source_snapshot" as const,
      })),
    });
    const provider = {
      resolveRevision: vi.fn(async () => resolvedRevision),
    } satisfies RepositoryProvider;
    const processor = createProcessor(store, createPreparation({ provider }));

    await expect(processor.process(job, new AbortController().signal)).resolves.toBe(
      "dead_lettered",
    );
    expect(provider.resolveRevision).not.toHaveBeenCalled();
    expect(failSourcePreparation).toHaveBeenCalledWith(
      expect.objectContaining({
        failure: {
          category: "source_invalid",
          message: "Deployment source metadata is invalid or unsupported",
        },
        retryable: false,
      }),
    );
  });

  it("keeps a timed-out non-cooperative checkout active without racing a failure write", async () => {
    const checkout = {
      prepare: vi.fn(() => new Promise<PreparedRepositoryCheckout>(() => undefined)),
      remove: vi.fn(async () => undefined),
    } satisfies RepositoryCheckout;
    const store = createStore();
    const processor = createProcessor(store, createPreparation({ checkout }), createLogger(), 5);

    await expect(processor.process(job, new AbortController().signal)).resolves.toBe("interrupted");
    expect(store.failSourcePreparation).not.toHaveBeenCalled();
    expect(processor.getActiveJobCount()).toBe(1);
  });

  it("does not resolve idle until a shutdown-interrupted checkout actually settles", async () => {
    let release: ((value: PreparedRepositoryCheckout) => void) | undefined;
    const checkoutResult = new Promise<PreparedRepositoryCheckout>((resolve) => {
      release = resolve;
    });
    const checkout = {
      prepare: vi.fn(() => checkoutResult),
      remove: vi.fn(async () => undefined),
    } satisfies RepositoryCheckout;
    const store = createStore();
    const shutdown = new AbortController();
    const processor = createProcessor(store, createPreparation({ checkout }));

    const processing = processor.process(job, shutdown.signal);
    await vi.waitFor(() => expect(checkout.prepare).toHaveBeenCalledOnce());
    shutdown.abort();
    await expect(processing).resolves.toBe("interrupted");
    expect(processor.getActiveJobCount()).toBe(1);

    const idle = processor.waitForIdle();
    release?.(preparedCheckout);
    await idle;
    expect(processor.getActiveJobCount()).toBe(0);
    expect(store.completeSourcePreparation).not.toHaveBeenCalled();
    expect(store.failSourcePreparation).not.toHaveBeenCalled();
  });
});
