import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // A run that finds no tests is a failure, not a pass. Otherwise a
    // deleted or misnamed test file silently turns the check green.
    passWithNoTests: false,
  },
});
