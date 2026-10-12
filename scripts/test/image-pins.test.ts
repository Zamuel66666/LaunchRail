import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("reviewed demonstration image references", () => {
  it.each(["compose.yaml", "compose.observability.yaml"])(
    "pins every service image in %s by digest",
    (path) => {
      const lines = readFileSync(new URL(`../../${path}`, import.meta.url), "utf8")
        .split("\n")
        .filter((line) => /^\s+image:/u.test(line));
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines)
        expect(line.trim()).toMatch(/^image: [a-z0-9./_-]+:[a-z0-9._-]+@sha256:[0-9a-f]{64}$/u);
    },
  );
  it.each(["healthy", "unhealthy", "node", "python", "slow-build"])(
    "pins the %s example base by digest",
    (name) => {
      const dockerfile = readFileSync(
        new URL(`../../examples/apps/${name}/Dockerfile`, import.meta.url),
        "utf8",
      );
      expect(dockerfile.split("\n")[0]).toMatch(
        /^FROM [a-z0-9./_-]+:[a-z0-9._-]+@sha256:[0-9a-f]{64}$/u,
      );
    },
  );
});
