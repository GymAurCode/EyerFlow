import { defineConfig } from "@playwright/test";

/**
 * End-to-end configuration.
 *
 * These tests drive the real packaged-style application through Electron, not a
 * browser against a mock, because the behaviour worth protecting here lives in
 * the main process: SQLCipher, migrations, permission checks and backup files.
 * A jsdom test would not touch any of it.
 *
 * `webServer` is not used: the renderer is loaded from disk via file://, so the
 * "server" is the build itself. Run `npm run build` first (the `pretest:e2e`
 * script does it).
 */
export default defineConfig({
  testDir: "./e2e",
  // Electron is a single shared resource on the machine (one user-data folder
  // per test is created, but the display and the native module are not), so
  // tests run one at a time.
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env["CI"]),
  retries: process.env["CI"] === undefined ? 0 : 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: process.env["CI"] === undefined ? [["list"]] : [["list"], ["html", { open: "never" }]],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
});