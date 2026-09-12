import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { TraefikFileRouteManager } from "../src/index.js";

const deploymentId = "11111111-1111-4111-8111-111111111111";
const route = { deploymentId, hostname: `d-${deploymentId}.localhost` } as const;

describe("TraefikFileRouteManager", () => {
  it("atomically writes a bounded localhost-only route then removes only that route", async () => {
    const directory = await mkdtemp(join(tmpdir(), "launchrail-routes-"));
    try {
      const manager = new TraefikFileRouteManager({ configurationDirectory: directory });
      await manager.apply(route, { hostPort: 43_123 });
      const file = join(directory, `launchrail-${deploymentId}.yaml`);
      await expect(readFile(file, "utf8")).resolves.toContain("http://host.docker.internal:43123");
      expect((await stat(file)).mode & 0o077).toBe(0);
      await manager.remove(route);
      await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects a hostname that is not exactly bound to its deployment", async () => {
    const directory = await mkdtemp(join(tmpdir(), "launchrail-routes-"));
    try {
      const manager = new TraefikFileRouteManager({ configurationDirectory: directory });
      await expect(
        manager.apply({ ...route, hostname: "example.com" }, { hostPort: 3000 }),
      ).rejects.toThrow(RangeError);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
