import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  matchesGitHubBranchFilter,
  parseGitHubPushEvent,
  verifyGitHubSignature,
} from "../src/index.js";

describe("GitHub webhook contracts", () => {
  it("verifies signatures without accepting malformed or altered bodies", async () => {
    const body = Buffer.from('{"ok":true}');
    const signature = `sha256=${createHmac("sha256", "secret").update(body).digest("hex")}`;
    await expect(verifyGitHubSignature(body, signature, "secret")).resolves.toBe(true);
    await expect(
      verifyGitHubSignature(Buffer.from('{"ok":false}'), signature, "secret"),
    ).resolves.toBe(false);
    await expect(verifyGitHubSignature(body, "sha1=bad", "secret")).resolves.toBe(false);
  });

  it("parses only exact push revisions and branch refs", () => {
    expect(
      parseGitHubPushEvent({
        after: "a".repeat(40),
        ref: "refs/heads/main",
        repository: { name: "app", owner: { login: "octo" } },
      }),
    ).toEqual({
      branch: "main",
      repositoryName: "app",
      repositoryOwner: "octo",
      revision: "a".repeat(40),
    });
    expect(parseGitHubPushEvent({ after: "a", ref: "refs/tags/v1" })).toBeNull();
  });

  it("matches explicit branch filters without treating regex syntax as input", () => {
    expect(matchesGitHubBranchFilter("main", "main")).toBe(true);
    expect(matchesGitHubBranchFilter("release/2026", "release/*")).toBe(true);
    expect(matchesGitHubBranchFilter("main", "ma.*")).toBe(false);
  });
});
