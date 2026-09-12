import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/runtime/test/**/*.runtime.integration.test.ts"],
    testTimeout: 120_000,
  },
});
