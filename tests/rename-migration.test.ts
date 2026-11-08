import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The rename migration.
 *
 * Electron derives the data folder from the product name, so renaming the
 * product to EyerStock moved it. Every installation made under the previous
 * name would otherwise have opened to an empty database and looked as though it
 * had lost its entire history.
 *
 * The test asserts the property that actually matters: the old folder is carried
 * across, and the migration can never destroy live data.
 */

vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => name,
  },
}));

import { resolvePaths, migrateLegacyDataDirectory } from "../src/main/app-context";

let root: string;
let appData: string;
let target: string;

const log = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "eyerstock-rename-"));
  appData = join(root, "AppData");
  target = join(appData, "EyerStock");
  mkdirSync(appData, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Build a data folder as the previous product name left it. */
function seedLegacyFolder(): string {
  const legacy = join(appData, "Minha Inventory");
  mkdirSync(join(legacy, "backups"), { recursive: true });
  writeFileSync(join(legacy, "minha-inventory.db"), "legacy-database-bytes");
  writeFileSync(join(legacy, "db-key.bin"), "legacy-key-bytes");
  writeFileSync(join(legacy, "settings.json"), '{"language":"en"}');
  writeFileSync(join(legacy, "backups", "minha-2026-01-01.db"), "backup-bytes");
  return legacy;
}

describe("paths under the new name", () => {
  it("uses the new database file name", () => {
    expect(resolvePaths(target).databasePath).toBe(join(target, "eyerstock.db"));
  });

  it("keeps the settings, logs, backups and exports folders", () => {
    const paths = resolvePaths(target);
    expect(paths.settingsFile).toBe(join(target, "settings.json"));
    expect(paths.logsDir).toBe(join(target, "logs"));
    expect(paths.defaultBackupDir).toBe(join(target, "backups"));
    expect(paths.exportsDir).toBe(join(target, "exports"));
  });
});

describe("migrating a pre-rename data folder", () => {
  it("moves the folder to the new name", () => {
    const legacy = seedLegacyFolder();

    const moved = migrateLegacyDataDirectory(target, appData, log);

    expect(moved).toBe(true);
    expect(existsSync(target)).toBe(true);
    expect(existsSync(legacy)).toBe(false);
  });

  it("carries the database, key, settings and backups across", () => {
    seedLegacyFolder();

    migrateLegacyDataDirectory(target, appData, log);

    expect(readFileSync(join(target, "db-key.bin"), "utf8")).toBe("legacy-key-bytes");
    expect(readFileSync(join(target, "settings.json"), "utf8")).toBe('{"language":"en"}');
    expect(existsSync(join(target, "backups", "minha-2026-01-01.db"))).toBe(true);
  });

  it("renames the database file so the new name finds it", () => {
    seedLegacyFolder();

    migrateLegacyDataDirectory(target, appData, log);

    // The bytes are what matters; the name is what the app now looks for.
    expect(readFileSync(resolvePaths(target).databasePath, "utf8")).toBe("legacy-database-bytes");
    expect(existsSync(join(target, "minha-inventory.db"))).toBe(false);
  });
});

describe("not migrating when it would be wrong", () => {
  it("leaves an existing new folder completely alone", () => {
    seedLegacyFolder();
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "eyerstock.db"), "current-database-bytes");

    const moved = migrateLegacyDataDirectory(target, appData, log);

    expect(moved).toBe(false);
    // The live data wins; the old folder is left for a human to resolve.
    expect(readFileSync(join(target, "eyerstock.db"), "utf8")).toBe("current-database-bytes");
    expect(existsSync(join(appData, "Minha Inventory", "minha-inventory.db"))).toBe(true);
  });

  it("does nothing when there is no previous folder", () => {
    expect(migrateLegacyDataDirectory(target, appData, log)).toBe(false);
  });

  it("is a no-op on a second start", () => {
    seedLegacyFolder();

    expect(migrateLegacyDataDirectory(target, appData, log)).toBe(true);
    // The old folder is gone now, so a second run must not touch anything.
    expect(migrateLegacyDataDirectory(target, appData, log)).toBe(false);
    expect(readFileSync(resolvePaths(target).databasePath, "utf8")).toBe("legacy-database-bytes");
  });
});
