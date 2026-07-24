import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**"],
    include: ["packages/database/test/**/*.integration.test.ts"],
    sequence: {
      concurrent: false,
    },
  },
});
