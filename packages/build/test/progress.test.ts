import { describe, expect, it } from "vitest";

import { BuildProgressConsumer, redactBuildLogText } from "../src/progress.js";

describe("build progress", () => {
  it("redacts credentials and terminal control sequences", () => {
    const result = redactBuildLogText(
      "\u001b[31mpassword=hunter2 Bearer abcdef https://user:pass@example.org explicit-secret",
      ["explicit-secret"],
    );
    expect(result).not.toContain("hunter2");
    expect(result).not.toContain("abcdef");
    expect(result).not.toContain("user:pass");
    expect(result).not.toContain("explicit-secret");
    expect(result).not.toContain("\u001b");
  });

  it("bounds retained output and counts each cached vertex once", async () => {
    const output: string[] = [];
    const consumer = new BuildProgressConsumer({
      maxChunkBytes: 16,
      maxRetainedBytes: 64,
      sink: {
        write: async (chunks) => {
          output.push(...chunks.map((chunk) => chunk.content));
        },
      },
    });
    const vertex = JSON.stringify({
      vertexes: [{ digest: "step", completed: "now", cached: true }],
    });
    await consumer.consumeLine(vertex, "stderr");
    await consumer.consumeLine(vertex, "stderr");
    await consumer.consumeLine(
      JSON.stringify({
        logs: [{ stream: 1, data: Buffer.from("x".repeat(1000)).toString("base64") }],
      }),
      "stderr",
    );
    expect(Buffer.byteLength(output.join(""))).toBeLessThanOrEqual(64);
    expect(consumer.cacheHitCount).toBe(1);
    expect(consumer.cacheMissCount).toBe(0);
  });
});
