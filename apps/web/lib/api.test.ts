import { expect, it, vi } from "vitest";
import {
  controlDeployment,
  createDeployment,
  DeploymentReadbackError,
  retryDeployment,
} from "./api";

it("uses a fresh rollback command key for each confirmed action so failed preparation can be retried", async () => {
  const fetchMock = vi.fn(
    async (_url: string, _options: RequestInit) => new Response(null, { status: 204 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  try {
    await controlDeployment("organization", "deployment", "rollback");
    await controlDeployment("organization", "deployment", "rollback");
    const keys = fetchMock.mock.calls.map(([, options]) =>
      new Headers(options.headers).get("idempotency-key"),
    );
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/u);
    expect(keys[1]).not.toBe(keys[0]);
    expect(fetchMock.mock.calls[0]?.[1].credentials).toBe("include");
  } finally {
    vi.unstubAllGlobals();
  }
});

it("reads retry timestamps and state from authoritative history rather than the creation acknowledgement", async () => {
  const persisted = {
    deploymentId: "retry",
    projectId: "project",
    createdAt: "2026-10-12T12:00:00.000Z",
    state: "queued",
  };
  const fetchMock = vi.fn(async (_url: string, options: RequestInit) =>
    Response.json(
      options.method === "POST"
        ? { deployment: { deploymentId: "retry", projectId: "project" } }
        : { deployments: [persisted] },
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  try {
    const retry = await retryDeployment("organization", "failed");
    expect(retry).toEqual(persisted);
    expect(Number.isFinite(new Date(retry.createdAt).getTime())).toBe(true);
    expect(fetchMock.mock.calls[1]?.[0]).toContain("/projects/project/deployments");
  } finally {
    vi.unstubAllGlobals();
  }
});

it.each(["create", "retry"])(
  "does not misreport an accepted %s as failed or repeat it when readback is unavailable",
  async (action) => {
    const fetchMock = vi.fn(async (_url: string, options: RequestInit) => {
      if (options.method === "POST")
        return Response.json({ deployment: { deploymentId: "accepted", projectId: "project" } });
      throw new Error("private upstream details");
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const operation =
        action === "create"
          ? createDeployment("organization", "project", "a".repeat(40))
          : retryDeployment("organization", "failed");
      await expect(operation).rejects.toThrow(DeploymentReadbackError);
      expect(fetchMock.mock.calls.filter(([, options]) => options.method === "POST")).toHaveLength(
        1,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  },
);
