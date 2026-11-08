import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Database migration tests touch the filesystem; keep them serial so
    // temp-dir and backup assertions cannot interleave.
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
    coverage: {
      provider: "v8",
      include: ["src/domain/**/*.ts", "src/data/**/*.ts"],
    },
  },
});
