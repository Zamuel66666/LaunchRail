import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/runtime/test/**/*.runtime.integration.test.ts",
      "test/examples/**/*.runtime.integration.test.ts",
    ],
    fileParallelism: false,
    testTimeout: 120_000,
  },
});
