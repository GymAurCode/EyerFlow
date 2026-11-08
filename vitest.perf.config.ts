import { defineConfig } from "vitest/config";

/**
 * Performance and query-plan tests.
 *
 * Kept out of the default suite on purpose: these seed 50,000 rows and assert
 * on wall-clock budgets, which is a different job from proving the arithmetic
 * is right and should not make `npm test` slow or flaky on a busy CI box.
 * Run with `npm run test:perf`.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["perf/**/*.test.ts"],
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
    // A single 50k seed is slow on a cold machine; the budgets inside the
    // tests are what actually protect performance, not the runner timeout.
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
