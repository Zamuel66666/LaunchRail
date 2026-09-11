import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { createFixtureBuildContext } from "../../../test/buildkit/fixture-context.js";
import { createPrivateBuildContextSnapshot } from "../src/context-snapshot.js";

it("rejects retained source content changed after its digest was recorded", async () => {
  const context = await createFixtureBuildContext("healthy");
  const root = await mkdtemp(join(tmpdir(), "launchrail-context-test-"));
  try {
    await writeFile(join(context.contextDirectory, "payload.txt"), "modified source");
    await expect(
      createPrivateBuildContextSnapshot({
        context,
        rootDirectory: root,
        signal: new AbortController().signal,
        workItemId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "build_context_changed" });
  } finally {
    await context.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
