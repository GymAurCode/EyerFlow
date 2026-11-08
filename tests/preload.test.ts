import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { IPC } from "../src/shared/ipc";

/**
 * The preload must not `require` anything of its own.
 *
 * The window runs sandboxed, and a sandboxed preload's `require` is a polyfill
 * that resolves Electron's built-in modules only. It cannot load a relative
 * file, so the preload importing the shared channel map at runtime threw while
 * the preload was still evaluating. `exposeInMainWorld` never ran, so the whole
 * renderer started with `window.api` undefined and every call site failed with
 * "Cannot read properties of undefined (reading 'invoke')" - a failure that only
 * appears at runtime, in the one file that security depends on being correct.
 *
 * The channel names are therefore written out in the preload. These tests are
 * what makes that safe: they are the only thing standing between an inline copy
 * and a channel that exists on one side and not the other.
 */

const preloadSource = readFileSync(join(process.cwd(), "src", "preload", "preload.ts"), "utf8");

/** The `CHANNEL` object as written in the preload, parsed out of the source. */
function preloadChannels(): Record<string, string> {
  const block = /const CHANNEL = \{([\s\S]*?)\} as const;/.exec(preloadSource);
  if (block === null) throw new Error("Could not find the CHANNEL map in the preload");

  const channels: Record<string, string> = {};
  for (const line of block[1]?.split("\n") ?? []) {
    const match = /^\s*(\w+):\s*"([^"]+)",\s*$/.exec(line);
    if (match !== null) {
      channels[match[1] as string] = match[2] as string;
    }
  }
  return channels;
}

describe("the preload runs with no runtime imports of its own", () => {
  it("requires nothing but electron", () => {
    // A type-only import is erased at compile time and emits no `require`, so
    // it is safe. A value import is not.
    const valueImports = [...preloadSource.matchAll(/^import\s+(?!type\s)\{([^}]*)\}/gm)].map(
      (match) => match[1]?.trim(),
    );

    expect(valueImports).toEqual(["contextBridge, ipcRenderer"]);
  });

  it("imports the shared module for types only", () => {
    expect(preloadSource).toMatch(/import type \{[\s\S]*?\}\s+from\s+"\.\.\/shared\/ipc"/);
    expect(preloadSource).not.toMatch(/^import \{ IPC \} from/m);
  });
});

describe("the preload's channel names match the shared map", () => {
  it("covers every channel", () => {
    const preload = preloadChannels();
    const shared = IPC as unknown as Record<string, string>;

    for (const [name, channel] of Object.entries(shared)) {
      expect(preload[name], `preload is missing the "${name}" channel`).toBe(channel);
    }
  });

  it("defines no channel the main process does not handle", () => {
    const shared = IPC as unknown as Record<string, string>;
    const sharedNames = new Set(Object.keys(shared));

    for (const name of Object.keys(preloadChannels())) {
      expect(sharedNames.has(name), `preload defines "${name}", which main does not`).toBe(true);
    }
  });

  it("keeps the same set of channel strings", () => {
    const preloadValues = Object.values(preloadChannels()).sort();
    const sharedValues = Object.values(IPC as unknown as Record<string, string>).sort();

    expect(preloadValues).toEqual(sharedValues);
  });
});

describe("the session token argument", () => {
  it("uses the same flag the main process passes", () => {
    const windowSource = readFileSync(join(process.cwd(), "src", "main", "window.ts"), "utf8");

    const passed = /--([a-z-]+)-token=/.exec(windowSource)?.[1];
    const read = /const prefix = "--([a-z-]+)-token="/.exec(preloadSource)?.[1];

    expect(passed).toBeDefined();
    expect(read).toBe(passed);
  });
});
