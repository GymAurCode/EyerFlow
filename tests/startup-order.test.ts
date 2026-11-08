import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Startup-order guards.
 *
 * These are assertions about the *shape* of the main process entry point rather
 * than about behaviour, because the failure they guard against happens before
 * any of the code under test could run: Electron refuses to create a
 * `BrowserWindow` before its `ready` event, and nothing else in the process is
 * reachable to catch it.
 *
 * The bug they exist to prevent was real. `main()` was invoked straight from
 * module scope. It appeared to work on a fresh install only because the
 * pre-migration backup is awaited and that await happened to span enough of the
 * event loop for Electron to become ready; on an already-migrated database
 * there was nothing to await, the promise resumed in a microtask - still before
 * `ready` - and the app exited with "Cannot create BrowserWindow before app is
 * ready". The gap only appeared once a database existed, which is why it
 * survived review and testing on a clean machine.
 */

const mainSource = readFileSync(join(process.cwd(), "src", "main", "main.ts"), "utf8");

describe("main process startup order", () => {
  it("waits for app ready before starting", () => {
    expect(mainSource).toMatch(/app\s*\n?\s*\.whenReady\(\)/);
  });

  it("does not invoke main directly at module scope", () => {
    // `void main()` at the top level is the exact shape that caused the bug.
    expect(mainSource).not.toMatch(/^\s*void main\(\)/m);
  });

  it("still reports a startup failure instead of dying silently", () => {
    expect(mainSource).toMatch(/Fatal startup error/);
    expect(mainSource).toMatch(/showErrorBox/);
  });
});

describe("data directory override", () => {
  it("redirects Chromium's userData before the instance lock is taken", () => {
    const setPathAt = mainSource.indexOf("app.setPath");
    const lockAt = mainSource.indexOf("app.requestSingleInstanceLock");

    expect(setPathAt).toBeGreaterThan(-1);
    expect(lockAt).toBeGreaterThan(-1);
    // Both are module-scope, so source order is execution order.
    expect(setPathAt).toBeLessThan(lockAt);
  });

  it("only touches the app when an override was actually requested", () => {
    // Calling app.getPath() before the app is ready is asking about state that
    // does not exist yet, so the guard has to short-circuit first.
    expect(mainSource).toMatch(/explicitDataDirOverride\(\)/);
  });
});
