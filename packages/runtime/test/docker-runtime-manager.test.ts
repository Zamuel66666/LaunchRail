import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DockerDeploymentRuntimeManager } from "../src/index.js";

const identity = {
  deploymentId: "11111111-1111-4111-8111-111111111111",
  organizationId: "22222222-2222-4222-8222-222222222222",
  projectId: "33333333-3333-4333-8333-333333333333",
  workItemId: "44444444-4444-4444-8444-444444444444",
} as const;

const command = {
  healthCheckPort: 3000,
  identity,
  image: {
    imageId: `sha256:${"a".repeat(64)}`,
    imageReference: "launchrail/local:verified",
    manifestDigest: `sha256:${"b".repeat(64)}`,
    platform: "linux/amd64",
  },
  runtimeConfig: {
    cpuMillicores: 500,
    memoryMegabytes: 128,
    processLimit: 64,
    readOnlyRootFilesystem: true,
  },
  signal: new AbortController().signal,
} as const;

const inspection = (managed = true) => [
  {
    Config: {
      Labels: managed
        ? {
            "dev.launchrail.deployment-id": identity.deploymentId,
            "dev.launchrail.image-id": command.image.imageId,
            "dev.launchrail.managed": "true",
            "dev.launchrail.manifest-digest": command.image.manifestDigest,
            "dev.launchrail.organization-id": identity.organizationId,
            "dev.launchrail.project-id": identity.projectId,
            "dev.launchrail.work-item-id": identity.workItemId,
          }
        : {},
      User: "65532:65532",
    },
    HostConfig: {
      CapDrop: ["ALL"],
      Memory: 128 * 1024 * 1024,
      MemorySwap: 128 * 1024 * 1024,
      NetworkMode: "bridge",
      PidsLimit: 64,
      PortBindings: { "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "43123" }] },
      ReadonlyRootfs: true,
      SecurityOpt: ["no-new-privileges:true"],
    },
    Id: "c".repeat(64),
    State: { Running: true },
  },
];

describe("DockerDeploymentRuntimeManager", () => {
  it("creates a restricted loopback-published runtime then verifies it", async () => {
    const root = await mkdtemp(join(tmpdir(), "launchrail-runtime-test-"));
    const requests: readonly string[][] = [];
    let inspectCount = 0;
    try {
      const manager = new DockerDeploymentRuntimeManager({
        dockerConfigDirectory: root,
        executor: {
          execute: async (request) => {
            (requests as string[][]).push([...request.arguments]);
            if (request.arguments[0] === "inspect") {
              inspectCount += 1;
              if (inspectCount === 1) throw new Error("missing");
              return { exitCode: 0, stderr: "", stdout: JSON.stringify(inspection()) };
            }
            return { exitCode: 0, stderr: "", stdout: "" };
          },
        },
        timeoutMs: 1_000,
      });
      await expect(manager.start(command)).resolves.toMatchObject({
        containerId: "c".repeat(64),
        hostPort: 43123,
      });
      const create = requests.find((request) => request[0] === "create");
      expect(create).toEqual(
        expect.arrayContaining([
          "--read-only",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges:true",
          "--pids-limit",
          "64",
          "--memory",
          "128m",
          "--memory-swap",
          "128m",
          "--publish",
          "127.0.0.1::3000/tcp",
          "--user",
          "65532:65532",
        ]),
      );
      expect(requests.some((request) => request[0] === "start")).toBe(true);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects an existing container without the expected labels", async () => {
    const root = await mkdtemp(join(tmpdir(), "launchrail-runtime-test-"));
    try {
      const manager = new DockerDeploymentRuntimeManager({
        dockerConfigDirectory: root,
        executor: {
          execute: async () => ({
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify(inspection(false)),
          }),
        },
        timeoutMs: 1_000,
      });
      await expect(manager.start(command)).rejects.toMatchObject({
        code: "runtime_metadata_invalid",
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("does not force a read-only root filesystem when the project disables it", async () => {
    const root = await mkdtemp(join(tmpdir(), "launchrail-runtime-test-"));
    const requests: string[][] = [];
    let inspectCount = 0;
    try {
      const manager = new DockerDeploymentRuntimeManager({
        dockerConfigDirectory: root,
        executor: {
          execute: async (request) => {
            requests.push([...request.arguments]);
            if (request.arguments[0] === "inspect") {
              inspectCount += 1;
              if (inspectCount === 1) throw new Error("missing");
              const existing = inspection()[0]!;
              return {
                exitCode: 0,
                stderr: "",
                stdout: JSON.stringify([
                  {
                    ...existing,
                    HostConfig: { ...existing.HostConfig, ReadonlyRootfs: false },
                  },
                ]),
              };
            }
            return { exitCode: 0, stderr: "", stdout: "" };
          },
        },
        timeoutMs: 1_000,
      });
      await manager.start({
        ...command,
        runtimeConfig: { ...command.runtimeConfig, readOnlyRootFilesystem: false },
      });
      expect(requests.find((request) => request[0] === "create")).not.toContain("--read-only");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
