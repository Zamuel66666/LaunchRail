import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, it } from "vitest";
import { DockerDeploymentRuntimeManager } from "../../packages/runtime/src/index.js";

const execute = promisify(execFile);

it.each(["healthy", "node", "python", "unhealthy"] as const)(
  "runs the %s example from the repository root under runtime restrictions",
  async (example) => {
    const imageReference = `launchrail-example-acceptance:${example}-${randomUUID()}`;
    const configDirectory = await mkdtemp(join(tmpdir(), "launchrail-example-docker-"));
    const identity = {
      deploymentId: randomUUID(),
      organizationId: randomUUID(),
      projectId: randomUUID(),
      workItemId: randomUUID(),
    };
    const manager = new DockerDeploymentRuntimeManager({
      dockerConfigDirectory: configDirectory,
      timeoutMs: 5000,
    });
    let containerId: string | undefined;
    try {
      await execute(
        "docker",
        [
          "buildx",
          "build",
          "--builder",
          process.env.LAUNCHRAIL_BUILDX_BUILDER ?? "launchrail-builder",
          "--file",
          `examples/apps/${example}/Dockerfile`,
          "--load",
          "--provenance=false",
          "--sbom=false",
          "--network=none",
          "--tag",
          imageReference,
          ".",
        ],
        { maxBuffer: 4 * 1024 * 1024 },
      );
      const inspected = JSON.parse(
        (await execute("docker", ["image", "inspect", imageReference])).stdout,
      )[0] as { Id: string };
      const runtime = await manager.start({
        identity,
        image: {
          imageId: inspected.Id,
          imageReference,
          manifestDigest: inspected.Id,
          platform: "linux/amd64",
        },
        healthCheckPort: 3000,
        runtimeConfig: {
          cpuMillicores: 500,
          memoryMegabytes: 256,
          processLimit: 64,
          readOnlyRootFilesystem: true,
        },
        signal: new AbortController().signal,
      });
      containerId = runtime.containerId;
      let response: Response | undefined;
      for (let attempt = 0; attempt < 50; attempt++) {
        try {
          response = await fetch(
            `http://127.0.0.1:${runtime.hostPort}${example === "unhealthy" ? "/missing-health" : "/"}`,
            { signal: AbortSignal.timeout(1000) },
          );
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      if (response === undefined) {
        const logs = await execute("docker", ["logs", "--tail", "30", runtime.containerId], {
          maxBuffer: 65536,
        });
        const state = await execute("docker", [
          "inspect",
          "--format",
          "{{json .State}}",
          runtime.containerId,
        ]);
        throw new Error(
          `Example ${example} did not become reachable: ${state.stdout.trim()}\n${logs.stdout}${logs.stderr}`,
        );
      }
      expect(response?.status).toBe(example === "unhealthy" ? 404 : 200);
      const body = await response?.text();
      if (example === "node" || example === "python")
        expect(JSON.parse(body ?? "")).toMatchObject({ healthy: true });
      if (example === "healthy") expect(body).toContain("LaunchRail deployment is healthy");
    } finally {
      if (containerId !== undefined)
        await manager.stop({ containerId, identity, signal: new AbortController().signal });
      await execute("docker", ["image", "rm", "--force", imageReference]).catch(() => undefined);
      await rm(configDirectory, { recursive: true, force: true });
    }
  },
  180000,
);
