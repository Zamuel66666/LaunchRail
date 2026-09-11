import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  computeRepositoryContextSha256,
  repositoryContextEmptyContentSha256,
  type RepositoryContextManifestEntry,
} from "../src/index.js";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const entries = [
  {
    contentSha256: repositoryContextEmptyContentSha256,
    kind: "directory",
    mode: "040000",
    path: "bin",
    size: 0,
  },
  {
    contentSha256: sha256("#!/bin/sh\n"),
    kind: "file",
    mode: "100755",
    path: "bin/start",
    size: 10,
  },
  {
    contentSha256: sha256("bin/start"),
    kind: "symlink",
    mode: "120000",
    path: "start",
    size: 9,
  },
] as const satisfies readonly RepositoryContextManifestEntry[];

describe("repository context manifest", () => {
  it("is stable across enumeration order", () => {
    const expected = computeRepositoryContextSha256(entries);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
    expect(computeRepositoryContextSha256([...entries].reverse())).toBe(expected);
  });

  it.each([
    [{ ...entries[1], contentSha256: sha256("#!/bin/false\n") }],
    [{ ...entries[1], mode: "100644" as const }],
    [{ ...entries[1], path: "bin/other" }],
    [{ ...entries[1], size: 11 }],
  ])("changes when canonical entry identity changes", (replacement) => {
    expect(computeRepositoryContextSha256([entries[0]!, replacement, entries[2]!])).not.toBe(
      computeRepositoryContextSha256(entries),
    );
  });

  it("rejects duplicates and unsafe paths", () => {
    expect(() => computeRepositoryContextSha256([...entries, entries[0]!])).toThrow("unique");
    expect(() => computeRepositoryContextSha256([{ ...entries[1]!, path: "../escape" }])).toThrow(
      "safe relative POSIX",
    );
  });
});
