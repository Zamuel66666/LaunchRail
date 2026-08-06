import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**"],
    fileParallelism: false,
    include: [
      "apps/api/test/**/*.database.integration.test.ts",
      "packages/database/test/**/*.integration.test.ts",
    ],
    sequence: {
      concurrent: false,
    },
  },
});
