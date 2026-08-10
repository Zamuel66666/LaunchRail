import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**"],
    fileParallelism: false,
    include: [
      "apps/worker/test/**/*.queue.integration.test.ts",
      "packages/queue/test/**/*.integration.test.ts",
    ],
    sequence: {
      concurrent: false,
    },
  },
});
