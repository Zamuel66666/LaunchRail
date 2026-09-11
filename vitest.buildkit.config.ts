import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**"],
    fileParallelism: false,
    hookTimeout: 60_000,
    include: ["test/buildkit/**/*.buildkit.integration.test.ts"],
    sequence: {
      concurrent: false,
    },
    testTimeout: 180_000,
  },
});
