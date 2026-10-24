import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@": path.resolve(import.meta.dirname, "client", "src"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/globalSetup.ts"],
    setupFiles: ["tests/setup.ts"],
    // Integration tests share one Postgres test database; each test file
    // creates uniquely-named data, but running files in parallel against
    // one connection pool budget is needlessly flaky for a suite this size.
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
