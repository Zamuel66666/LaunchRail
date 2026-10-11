import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { BuildKitImageBuilder } from "../src/buildkit-image-builder.js";

describe("BuildKit readiness", () => {
  it("bootstraps only the explicitly configured builder", async () => {
    const root = await mkdtemp(join(tmpdir(), "launchrail-buildkit-readiness-"));
    const calls: string[][] = [];
    const builder = new BuildKitImageBuilder({
      buildRootDirectory: join(root, "build"),
      builderName: "launchrail-explicit",
      dockerConfigDirectory: join(root, "docker-config"),
      executor: {
        execute: async (request) => {
          calls.push([...request.arguments]);
          return { exitCode: 0, stderr: "", stdout: "" };
        },
      },
      platform: "linux/amd64",
      timeoutMs: 1_000,
    });

    try {
      await expect(builder.checkReady()).resolves.toBe(true);
      expect(calls).toEqual([
        ["buildx", "inspect", "--builder", "launchrail-explicit", "--bootstrap"],
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("reports an unavailable daemon or builder without leaking command output", async () => {
    const root = await mkdtemp(join(tmpdir(), "launchrail-buildkit-readiness-"));
    const builder = new BuildKitImageBuilder({
      buildRootDirectory: join(root, "build"),
      dockerConfigDirectory: join(root, "docker-config"),
      executor: {
        execute: async () => {
          throw new Error("private daemon diagnostic");
        },
      },
      platform: "linux/amd64",
      timeoutMs: 1_000,
    });

    try {
      await expect(builder.checkReady()).resolves.toBe(false);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
