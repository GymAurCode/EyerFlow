import { describe, expect, it } from "vitest";
import manifest from "../package.json";
import { APP_VERSION } from "../src/renderer/lib/app-version";

/**
 * The installer, the updater and the in-app footer all have to agree on what
 * version this build is. The first two read package.json; the footer cannot,
 * because it is bundled into the renderer, so it carries its own copy. This is
 * the check that keeps that copy honest.
 */
describe("application version", () => {
  it("matches the version in package.json", () => {
    expect(APP_VERSION).toBe(manifest.version);
  });
});
