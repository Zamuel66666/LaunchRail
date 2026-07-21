import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";

export default defineConfig([
  ...nextVitals,
  {
    settings: {
      next: { rootDir: "apps/web" },
      react: { version: "19.2.7" },
    },
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  globalIgnores(["**/.next/**", "**/coverage/**", "**/dist/**", "**/node_modules/**"]),
]);
