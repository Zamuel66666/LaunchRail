import { describe, expect, it } from "vitest";
import { acceptanceProjectUpdate } from "../acceptance-project-update.mjs";

describe("acceptance project update contract", () => {
  const project = {
    id: "opaque",
    version: 3,
    name: "Synthetic",
    repositoryUrl: "https://github.com/example/example",
    defaultBranch: "main",
    dockerfilePath: "Dockerfile",
    healthCheckPath: "/",
    healthCheckPort: 3000,
    runtimeConfig: {
      cpuMillicores: 500,
      memoryMegabytes: 512,
      processLimit: 128,
      readOnlyRootFilesystem: true,
    },
    secrets: [{ name: "DO_NOT_FORWARD" }],
    organizationId: "private",
    createdAt: "private",
  };
  it("sends a full validated configuration and current version without response-only metadata", () => {
    const command = acceptanceProjectUpdate(project, {
      dockerfilePath: "examples/apps/slow-build/Dockerfile",
    });
    expect(command).toEqual({
      name: project.name,
      repositoryUrl: project.repositoryUrl,
      defaultBranch: project.defaultBranch,
      dockerfilePath: "examples/apps/slow-build/Dockerfile",
      healthCheckPath: project.healthCheckPath,
      healthCheckPort: project.healthCheckPort,
      runtimeConfig: project.runtimeConfig,
      expectedVersion: 3,
    });
    expect(project.dockerfilePath).toBe("Dockerfile");
    expect(JSON.stringify(command)).not.toContain("private");
    expect(JSON.stringify(command)).not.toContain("DO_NOT_FORWARD");
  });
  it("rejects unknown fields instead of forwarding response metadata or authority", () => {
    expect(() => acceptanceProjectUpdate(project, { organizationId: "other" })).toThrow(
      "Unsupported acceptance project change",
    );
  });
});
