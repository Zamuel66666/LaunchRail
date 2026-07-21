import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      enabled: false,
      provider: "v8",
    },
    exclude: ["**/*.integration.test.ts", "**/node_modules/**", "**/.next/**", "**/dist/**"],
    include: ["apps/**/*.test.ts", "packages/**/*.test.ts"],
  },
});
