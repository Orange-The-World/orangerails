import { defineConfig } from "vitest/config";

// Self-contained on purpose. Without a config file in this directory, vitest looks upward
// and loads the repository root config, which imports from a root node_modules that a
// package-only install does not have. This keeps the package's tests independent of it.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
