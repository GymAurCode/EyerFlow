/**
 * The renderer must never be left waiting forever.
 *
 * The Activate button used to spin indefinitely. `ipcRenderer.invoke` settles
 * only when the main process answers, and the main process can be busy for
 * reasons the renderer cannot see - reading hardware identifiers shells out to
 * the OS three times - so "no answer" and "slow answer" looked identical and
 * nothing ever reset the loading state.
 *
 * These tests pin the mechanism that fixes it: every call carries a ceiling,
 * and the ceiling produces a message the user can act on rather than a spinner
 * with no explanation.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiException, DEFAULT_CALL_TIMEOUT_MS, call } from "../src/renderer/lib/api";
import type { ApiResult } from "../src/shared/ipc";

/** A bridge whose invoke never settles - the shape of a stuck main process. */
function hangingBridge(): { invoke: () => Promise<never> } {
  return { invoke: () => new Promise<never>(() => undefined) };
}

function installBridge(
  invoke: (method: string, payload: unknown) => Promise<ApiResult<unknown>>,
): void {
  (globalThis as unknown as { window: unknown }).window = { api: { invoke } };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe("call() timeout", () => {
  it("defaults to a ten second ceiling", () => {
    expect(DEFAULT_CALL_TIMEOUT_MS).toBe(10_000);
  });

  it("rejects with a message the user can act on when the main process never answers", async () => {
    installBridge(hangingBridge().invoke);

    const pending = call("license.activate", { key: "abc" });
    const assertion = expect(pending).rejects.toThrowError(ApiException);

    await vi.advanceTimersByTimeAsync(DEFAULT_CALL_TIMEOUT_MS);
    await assertion;
  });

  it("says what happened rather than leaving a spinner with no reason", async () => {
    installBridge(hangingBridge().invoke);

    const pending = call("license.activate", { key: "abc" }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(DEFAULT_CALL_TIMEOUT_MS);
    const error = (await pending) as ApiException;

    expect(error).toBeInstanceOf(ApiException);
    expect(error.code).toBe("TIMEOUT");
    expect(error.message).toContain("10 seconds");
    expect(error.message).toMatch(/reopen|open it again|try/i);
  });

  it("stays pending right up to the ceiling, so a slow answer is not cut off", async () => {
    installBridge(hangingBridge().invoke);

    let settled = false;
    const pending = call("license.activate", { key: "abc" }).then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await vi.advanceTimersByTimeAsync(DEFAULT_CALL_TIMEOUT_MS - 1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(settled).toBe(true);
  });

  it("clears the timer on success so nothing is left running", async () => {
    installBridge(async () => ({ ok: true, data: { a: 1 } }));

    const result = await call("license.activate", { key: "abc" }, { timeoutMs: 50 });

    expect(result).toEqual({ a: 1 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the timer on failure too", async () => {
    installBridge(async () => ({
      ok: false,
      error: { code: "LICENSE", message: "Key expired" },
    }));

    await expect(call("license.activate", { key: "abc" }, { timeoutMs: 50 })).rejects.toThrow(
      "Key expired",
    );
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("call() failure surface", () => {
  it("turns a rejected bridge into an ApiException the screen can render", async () => {
    installBridge(async () => {
      throw new Error("bridge went away");
    });

    await expect(call("license.activate", { key: "abc" })).rejects.toThrowError(ApiException);
  });

  it("passes a typed domain failure through with its wording intact", async () => {
    installBridge(async () => ({
      ok: false,
      error: { code: "LICENSE", message: "This key is for a different computer" },
    }));

    const error = await call("license.activate", { key: "abc" }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiException);
    expect((error as ApiException).message).toBe("This key is for a different computer");
  });

  it("explains a missing bridge rather than reporting undefined", async () => {
    // The window exists but the preload never ran, so `window.api` is absent.
    (globalThis as unknown as { window: unknown }).window = {};

    await expect(call("license.activate", { key: "abc" })).rejects.toThrow(/main process/);
  });
});
