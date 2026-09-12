import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BuildKitImageBuilder } from "../../packages/build/src/index.js";
import { createFixtureBuildContext } from "./fixture-context.js";

describe("real BuildKit image lifecycle", () => {
  let root: string;
  let builder: BuildKitImageBuilder;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "launchrail-build-acceptance-"));
    builder = new BuildKitImageBuilder({
      buildRootDirectory: root,
      builderName: process.env.LAUNCHRAIL_BUILDX_BUILDER ?? "launchrail-builder",
      dockerConfigDirectory: process.env.DOCKER_CONFIG ?? join(root, "docker-config"),
      platform: "linux/amd64",
      timeoutMs: 120_000,
    });
  });

  afterAll(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  });

  const identity = () => ({
    deploymentId: randomUUID(),
    organizationId: randomUUID(),
    projectId: randomUUID(),
    sourceRevision: "a".repeat(40),
    treeRevision: "b".repeat(40),
    workItemId: randomUUID(),
  });

  it("builds an exact image and adopts it after a worker retry", async () => {
    const context = await createFixtureBuildContext("healthy");
    const command = {
      attempt: 1,
      context,
      identity: identity(),
      signal: new AbortController().signal,
    };
    const sink = { write: async () => undefined };
    try {
      const first = await builder.build(command, sink);
      expect(first.imageId).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(first.imageDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(first.adopted).toBe(false);
      const retry = await builder.build({ ...command, attempt: 2 }, sink);
      expect(retry.adopted).toBe(true);
      expect(retry.imageId).toBe(first.imageId);
      expect(retry.imageReference).toBe(first.imageReference);
    } finally {
      await builder.remove(command);
      await context.dispose();
    }
  });

  it("reports a failing Dockerfile without producing a successful artifact", async () => {
    const context = await createFixtureBuildContext("failure");
    const command = {
      attempt: 1,
      context,
      identity: identity(),
      signal: new AbortController().signal,
    };
    try {
      await expect(builder.build(command, { write: async () => undefined })).rejects.toMatchObject({
        code: "build_failed",
      });
    } finally {
      await builder.remove(command);
      await context.dispose();
    }
  });

  it("redacts build output before delivery", async () => {
    const context = await createFixtureBuildContext("redaction");
    const command = {
      attempt: 1,
      context,
      identity: identity(),
      signal: new AbortController().signal,
    };
    const output: string[] = [];
    try {
      await builder.build(command, {
        write: async (chunks) => {
          output.push(...chunks.map((chunk) => chunk.content));
        },
      });
      expect(output.join("")).toContain("[REDACTED]");
      expect(output.join("")).not.toContain("launchrail-build-secret-canary");
    } finally {
      await builder.remove(command);
      await context.dispose();
    }
  });

  it("reuses cached build steps for another deployment of the same project", async () => {
    const context = await createFixtureBuildContext("cache");
    const first = {
      attempt: 1,
      context,
      identity: identity(),
      signal: new AbortController().signal,
    };
    const second = {
      ...first,
      identity: { ...first.identity, deploymentId: randomUUID(), workItemId: randomUUID() },
    };
    try {
      await builder.build(first, { write: async () => undefined });
      const result = await builder.build(second, { write: async () => undefined });
      expect(result.adopted).toBe(false);
      expect(result.cacheHitCount).toBeGreaterThan(0);
    } finally {
      await builder.remove(first);
      await builder.remove(second);
      await context.dispose();
    }
  });

  it("cancels an active build when the worker aborts", async () => {
    const context = await createFixtureBuildContext("timeout");
    const controller = new AbortController();
    const command = { attempt: 1, context, identity: identity(), signal: controller.signal };
    const reason = new Error("worker shutdown");
    const timer = setTimeout(() => controller.abort(reason), 3_000);
    try {
      await expect(builder.build(command, { write: async () => undefined })).rejects.toBe(reason);
    } finally {
      clearTimeout(timer);
      await builder.remove({ ...command, signal: new AbortController().signal });
      await context.dispose();
    }
  });

  it("classifies its own deadline as a build timeout", async () => {
    const context = await createFixtureBuildContext("timeout");
    const command = {
      attempt: 1,
      context,
      identity: identity(),
      signal: new AbortController().signal,
    };
    const boundedBuilder = new BuildKitImageBuilder({
      buildRootDirectory: root,
      builderName: process.env.LAUNCHRAIL_BUILDX_BUILDER ?? "launchrail-builder",
      dockerConfigDirectory: process.env.DOCKER_CONFIG ?? join(root, "docker-config"),
      platform: "linux/amd64",
      timeoutMs: 3_000,
    });
    try {
      await expect(
        boundedBuilder.build(command, { write: async () => undefined }),
      ).rejects.toMatchObject({ code: "build_timeout" });
    } finally {
      await builder.remove(command);
      await context.dispose();
    }
  });

  it("rejects excessive raw build output", async () => {
    const context = await createFixtureBuildContext("output-limit");
    const command = {
      attempt: 1,
      context,
      identity: identity(),
      signal: new AbortController().signal,
    };
    const boundedBuilder = new BuildKitImageBuilder({
      buildRootDirectory: root,
      builderName: process.env.LAUNCHRAIL_BUILDX_BUILDER ?? "launchrail-builder",
      dockerConfigDirectory: process.env.DOCKER_CONFIG ?? join(root, "docker-config"),
      limits: { maxProgressBytes: 32_768, maxProgressLineBytes: 16_384 },
      platform: "linux/amd64",
      timeoutMs: 120_000,
    });
    try {
      await expect(
        boundedBuilder.build(command, { write: async () => undefined }),
      ).rejects.toMatchObject({ code: "build_output_limit_exceeded" });
    } finally {
      await builder.remove(command);
      await context.dispose();
    }
  });
});
