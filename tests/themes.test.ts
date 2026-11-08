/**
 * Theme catalogue, persistence and stylesheet coverage.
 *
 * The three have to agree: an id the settings table accepts but the stylesheet
 * does not paint would leave a window with no palette, and an id the picker
 * shows but the store cannot write would look like it worked until relaunch.
 * These tests are the contract between the three files.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SNAPSHOT,
  SETTING_KEYS,
  getSetting,
  isWritableField,
  loadSnapshot,
  settingKeyFor,
  writeSetting,
} from "../src/main/settings-store";
import {
  DEFAULT_THEME_ID,
  THEME_CATALOG,
  THEME_CATEGORIES,
  THEME_IDS,
  isThemeId,
  normaliseThemeId,
  themeDefinition,
} from "../src/shared/themes";
import { settingsUpdateSchema } from "../src/shared/validation";
import { freshDb, migrateInMemory } from "./helpers";

const FILE_SETTINGS = {
  backupDirectory: "",
  backupKeepCount: 30,
  dailyBackupEnabled: true,
  dailyBackupHour: 2,
} as const;

function migratedDb() {
  const db = freshDb();
  migrateInMemory(db);
  return db;
}

describe("theme catalogue", () => {
  it("lists the fifteen shipped packs exactly once each", () => {
    expect(THEME_IDS).toHaveLength(15);
    expect(new Set(THEME_IDS).size).toBe(THEME_IDS.length);
    expect(THEME_CATALOG).toHaveLength(THEME_IDS.length);
    expect(new Set(THEME_CATALOG.map((entry) => entry.id))).toEqual(new Set(THEME_IDS));
  });

  it("gives every pack a name, a description and a known category", () => {
    for (const entry of THEME_CATALOG) {
      expect(entry.name.trim().length).toBeGreaterThan(0);
      expect(entry.blurb.trim().length).toBeGreaterThan(0);
      expect(THEME_CATEGORIES).toContain(entry.category);
      expect(themeDefinition(entry.id)).toBe(entry);
    }
  });

  it("keeps Ocean Teal as the default so existing installs do not change colour", () => {
    expect(DEFAULT_THEME_ID).toBe("ocean-teal");
    expect(DEFAULT_SNAPSHOT.themePalette).toBe(DEFAULT_THEME_ID);
    expect(isThemeId(DEFAULT_THEME_ID)).toBe(true);
  });

  it("rejects untrusted ids and falls back to the default", () => {
    expect(isThemeId("midnight-navy")).toBe(true);
    expect(isThemeId("not-a-theme")).toBe(false);
    expect(isThemeId(42)).toBe(false);
    expect(isThemeId(null)).toBe(false);
    expect(normaliseThemeId("royal-indigo")).toBe("royal-indigo");
    expect(normaliseThemeId("not-a-theme")).toBe(DEFAULT_THEME_ID);
    expect(normaliseThemeId(undefined)).toBe(DEFAULT_THEME_ID);
  });

  it("refuses to invent a definition for an unknown id", () => {
    expect(() => themeDefinition("not-a-theme" as never)).toThrow(/unknown theme/i);
  });
});

describe("theme palette persistence", () => {
  it("gives a database that predates palettes the default pack", () => {
    const snapshot = loadSnapshot(migratedDb(), FILE_SETTINGS);
    expect(snapshot.themePalette).toBe(DEFAULT_THEME_ID);
  });

  it("writes and reads a pack under its own settings key", () => {
    const db = migratedDb();

    expect(isWritableField("themePalette")).toBe(true);
    expect(settingKeyFor("themePalette")).toBe(SETTING_KEYS.themePalette);

    writeSetting(db, SETTING_KEYS.themePalette, "burgundy-wine");

    expect(getSetting(db, SETTING_KEYS.themePalette)).toBe("burgundy-wine");
    expect(loadSnapshot(db, FILE_SETTINGS).themePalette).toBe("burgundy-wine");
  });

  it("keeps the mode and the pack independent", () => {
    const db = migratedDb();

    writeSetting(db, SETTING_KEYS.theme, "dark");
    writeSetting(db, SETTING_KEYS.themePalette, "sandstone");

    const snapshot = loadSnapshot(db, FILE_SETTINGS);
    expect(snapshot.theme).toBe("dark");
    expect(snapshot.themePalette).toBe("sandstone");
  });

  it("does not let a hand-edited or future value break the window", () => {
    const db = migratedDb();
    writeSetting(db, SETTING_KEYS.themePalette, "a-pack-from-a-newer-build");

    expect(loadSnapshot(db, FILE_SETTINGS).themePalette).toBe(DEFAULT_THEME_ID);
  });

  it("accepts every shipped pack at the IPC boundary", () => {
    // The update schema is strict, so a field it does not list is rejected.
    // Missing this is invisible in a unit test of the store: the renderer's
    // optimistic write is simply refused and the click silently rolls back.
    for (const id of THEME_IDS) {
      const parsed = settingsUpdateSchema.safeParse({ themePalette: id });
      expect(parsed.success, id).toBe(true);
    }

    expect(settingsUpdateSchema.safeParse({ themePalette: "not-a-theme" }).success).toBe(false);
    expect(settingsUpdateSchema.safeParse({ unknownField: true }).success).toBe(false);
  });

  it("records whether the first-login chooser has been handled", () => {
    const db = migratedDb();

    expect(DEFAULT_SNAPSHOT.themeOnboardingComplete).toBe(false);
    expect(loadSnapshot(db, FILE_SETTINGS).themeOnboardingComplete).toBe(false);
    expect(isWritableField("themeOnboardingComplete")).toBe(true);
    expect(settingKeyFor("themeOnboardingComplete")).toBe(SETTING_KEYS.themeOnboardingComplete);

    writeSetting(db, SETTING_KEYS.themeOnboardingComplete, "1");

    expect(loadSnapshot(db, FILE_SETTINGS).themeOnboardingComplete).toBe(true);
    expect(settingsUpdateSchema.safeParse({ themeOnboardingComplete: true }).success).toBe(true);
    expect(settingsUpdateSchema.safeParse({ themeOnboardingComplete: "yes" }).success).toBe(false);
  });
});

describe("stylesheet coverage", () => {
  const styles = readFileSync(join(process.cwd(), "src", "renderer", "styles.css"), "utf8");

  it("paints every catalogue pack in both modes", () => {
    for (const id of THEME_IDS) {
      expect(styles).toContain(`[data-theme="light"][data-palette="${id}"]`);
      expect(styles).toContain(`[data-theme="dark"][data-palette="${id}"]`);
    }
  });

  it("declares the semantic vocabulary the UI consumes", () => {
    for (const token of [
      "--app-bg",
      "--header-bg",
      "--surface-hover",
      "--surface-active",
      "--primary",
      "--primary-hover",
      "--primary-subtle",
      "--text-primary",
      "--text-secondary",
      "--text-muted",
      "--table-header-bg",
      "--table-row-hover",
      "--focus-ring",
      "--overlay-bg",
      "--success",
      "--warning",
      "--danger",
      "--info",
    ]) {
      expect(styles).toContain(`${token}:`);
    }
  });

  it("lets an isolated preview resolve a pack that is not on <html>", () => {
    expect(styles).toContain("[data-preview-surface]");
  });

  it("derives the sign-in panel from the active palette", () => {
    // The login screen used to be fixed teal while the app followed the
    // chosen pack. These are the links that keep the two together.
    expect(styles).toMatch(/\.auth-panel\s*\{[^}]*--auth-panel-bg:\s*var\(--sidebar-bg\)/s);
    expect(styles).toMatch(/--auth-panel-ink:\s*var\(--sidebar-text\)/);
    expect(styles).toMatch(/--auth-panel-accent:\s*color-mix\(in srgb, var\(--brand\)/);
    expect(styles).not.toContain("--auth-panel-bg: #0d3d3a");
  });
});

describe("pre-paint palette hint", () => {
  it("reads the stored pack before the bridge is available", () => {
    const boot = readFileSync(
      join(process.cwd(), "src", "renderer", "public", "theme-boot.js"),
      "utf8",
    );

    expect(boot).toContain("eyerstock.themePalette");
    expect(boot).toContain("data-palette");
  });
});
