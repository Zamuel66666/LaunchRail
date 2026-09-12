import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DockerDeploymentRuntimeManager } from "../src/index.js";

const execFileAsync = promisify(execFile);
const baseImageReference =
  "busybox:1.37.0-musl@sha256:fc6dddc4c44b1bfe37f41cae8e67d1693828e8f42a91862816d7953e2c9d3f23";
const imageReference = "launchrail-runtime-acceptance:local";
const deploymentId = "11111111-1111-4111-8111-111111111111";
const organizationId = "22222222-2222-4222-8222-222222222222";
const projectId = "33333333-3333-4333-8333-333333333333";
const workItemId = "44444444-4444-4444-8444-444444444444";

async function docker(...arguments_: string[]): Promise<string> {
  return (await execFileAsync("docker", arguments_, { maxBuffer: 1_048_576 })).stdout;
}

describe("DockerDeploymentRuntimeManager (real Docker)", () => {
  let configDirectory = "";
  let imageDirectory = "";
  let imageId = "";
  let manager: DockerDeploymentRuntimeManager;

  beforeAll(async () => {
    configDirectory = await mkdtemp(join(tmpdir(), "launchrail-runtime-docker-"));
    imageDirectory = await mkdtemp(join(tmpdir(), "launchrail-runtime-image-"));
    await docker("pull", baseImageReference);
    await writeFile(
      join(imageDirectory, "Dockerfile"),
      `FROM ${baseImageReference}\nCMD ["sleep", "600"]\n`,
      "utf8",
    );
    await docker("build", "--tag", imageReference, imageDirectory);
    imageId = (await docker("image", "inspect", "--format", "{{.Id}}", imageReference)).trim();
    manager = new DockerDeploymentRuntimeManager({
      dockerConfigDirectory: configDirectory,
      timeoutMs: 30_000,
    });
  });

  afterAll(async () => {
    await docker("rm", "--force", `launchrail-runtime-${deploymentId}`).catch(() => undefined);
    await docker("image", "rm", "--force", imageReference).catch(() => undefined);
    await rm(configDirectory, { force: true, recursive: true });
    await rm(imageDirectory, { force: true, recursive: true });
  });

  it("creates, adopts, and removes a loopback-only constrained runtime", async () => {
    const controller = new AbortController();
    const command = {
      healthCheckPort: 3000,
      identity: { deploymentId, organizationId, projectId, workItemId },
      image: {
        imageId,
        imageReference,
        manifestDigest: "sha256:fc6dddc4c44b1bfe37f41cae8e67d1693828e8f42a91862816d7953e2c9d3f23",
        platform: "linux/amd64",
      },
      runtimeConfig: {
        cpuMillicores: 500,
        memoryMegabytes: 128,
        processLimit: 64,
        readOnlyRootFilesystem: true,
      },
      signal: controller.signal,
    } as const;
    const created = await manager.start(command);
    const adopted = await manager.start(command);
    expect(adopted).toEqual(created);
    const raw = JSON.parse(await docker("inspect", created.containerId)) as readonly [
      {
        readonly HostConfig: {
          readonly CapDrop: readonly string[];
          readonly Memory: number;
          readonly MemorySwap: number;
          readonly NetworkMode: string;
          readonly PidsLimit: number;
          readonly ReadonlyRootfs: boolean;
          readonly SecurityOpt: readonly string[];
        };
      },
    ];
    expect(raw[0]?.HostConfig).toMatchObject({
      CapDrop: expect.arrayContaining(["ALL"]),
      Memory: 128 * 1024 * 1024,
      MemorySwap: 128 * 1024 * 1024,
      NetworkMode: "bridge",
      PidsLimit: 64,
      ReadonlyRootfs: true,
      SecurityOpt: expect.arrayContaining(["no-new-privileges:true"]),
    });
    await manager.stop({
      containerId: created.containerId,
      identity: command.identity,
      signal: controller.signal,
    });
    await expect(docker("inspect", created.containerId)).rejects.toThrow();
  });
});
