import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    environment: "node",
    // A file that is not on this list is not collected, and a test that is
    // never collected cannot fail, so the job goes green having run nothing.
    // Add the directory here when you put a test in a new one.
    include: [
      "src/**/*.test.ts",
      "tests/**/*.test.ts",
      "scripts/**/*.test.mjs",
    ],
  },
});
