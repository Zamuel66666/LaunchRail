import { lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";
import { privateDirectory } from "../local-environment.mjs";

it("prepares owned directories with private permissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "launchrail-local-setup-"));
  try {
    const directory = join(root, "configuration");
    await mkdir(directory, { mode: 0o755 });
    await privateDirectory(directory);
    expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    await privateDirectory(directory);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects symlinked ancestors before creating infrastructure directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "launchrail-local-setup-"));
  try {
    const target = join(root, "target");
    await mkdir(target);
    await symlink(target, join(root, "redirect"));
    await expect(privateDirectory(join(root, "redirect", "new"))).rejects.toThrow("symlinked");
    await expect(lstat(join(target, "new"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(privateDirectory("/")).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
