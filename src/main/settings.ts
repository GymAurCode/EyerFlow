/**
 * Application settings.
 *
 * Split by lifetime, not by convenience:
 *  - backup/licensing settings live in settings.json, outside the database, so
 *    they survive a database restore (otherwise a restore could leave the shop
 *    pointing at a folder the previous install used);
 *  - business settings live in the `settings` table, so they roll back with the
 *    data they describe (company name, invoice wording, fiscal year).
 *
 * `SettingsService` joins the two into the single snapshot the UI sees.
 */

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname } from "node:path";
import type { SqliteDatabase } from "../data/connection";
import type { AppSettingsSnapshot } from "../shared/ipc";
import type { Logger } from "./logger";
import {
  DEFAULT_SNAPSHOT,
  SETTING_KEYS,
  getSetting,
  isWritableField,
  loadSnapshot,
  settingKeyFor,
  writeSetting,
} from "./settings-store";

/** The half of the settings that is stored as JSON. */
export interface FileSettings {
  readonly backupDirectory: string;
  readonly backupKeepCount: number;
  readonly dailyBackupEnabled: boolean;
  readonly dailyBackupHour: number;
  readonly lastBackupAtIso: string | null;
}

export const DEFAULT_FILE_SETTINGS: FileSettings = {
  backupDirectory: "",
  backupKeepCount: 30,
  dailyBackupEnabled: true,
  dailyBackupHour: 2,
  lastBackupAtIso: null,
};

export type UpdateSettings = Partial<AppSettingsSnapshot>;

/** Largest company logo that will be inlined into the settings snapshot. */
const MAX_LOGO_BYTES = 512 * 1024;

function coerceNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function coerceBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function coerceString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

/**
 * Merge a parsed JSON object over the defaults.
 *
 * Every field is coerced rather than trusted: a hand-edited settings file must
 * not be able to set `backupKeepCount` to a negative number and break retention.
 */
export function normaliseFileSettings(input: unknown): FileSettings {
  if (typeof input !== "object" || input === null) {
    return DEFAULT_FILE_SETTINGS;
  }

  const raw = input as Record<string, unknown>;

  return {
    backupDirectory: coerceString(raw.backupDirectory, DEFAULT_FILE_SETTINGS.backupDirectory),
    backupKeepCount: coerceNumber(
      raw.backupKeepCount,
      DEFAULT_FILE_SETTINGS.backupKeepCount,
      1,
      3650,
    ),
    dailyBackupEnabled: coerceBoolean(
      raw.dailyBackupEnabled,
      DEFAULT_FILE_SETTINGS.dailyBackupEnabled,
    ),
    dailyBackupHour: coerceNumber(raw.dailyBackupHour, DEFAULT_FILE_SETTINGS.dailyBackupHour, 0, 23),
    lastBackupAtIso:
      typeof raw.lastBackupAtIso === "string" ? raw.lastBackupAtIso : DEFAULT_FILE_SETTINGS.lastBackupAtIso,
  };
}
export function loadFileSettings(settingsPath: string, log: Logger): FileSettings {
  if (!existsSync(settingsPath)) {
    return DEFAULT_FILE_SETTINGS;
  }

  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
    return normaliseFileSettings(parsed);
  } catch (error) {
    // Never block startup on a bad settings file: fall back to defaults and
    // leave the file alone so the shopkeeper's values are recoverable.
    log.error("Failed to read settings, falling back to defaults", {
      settingsPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return DEFAULT_FILE_SETTINGS;
  }
}

export function saveFileSettings(
  settingsPath: string,
  settings: FileSettings,
  log: Logger,
): void {
  try {
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  } catch (error) {
    log.error("Failed to persist settings", {
      settingsPath,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new Error("Could not save settings. Check that the data folder is writable.");
  }
}

/* -------------------------------------------------------------------------- */
/* service                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Reads and writes both halves of the settings.
 *
 * Business fields go to the database inside the caller's permission check;
 * backup fields go to the file. Neither writes a value the other owns, so the
 * two can never fight over the same key.
 */
export class SettingsService {
  private fileSettings: FileSettings;
  private snapshot: AppSettingsSnapshot;

  public constructor(
    private readonly db: SqliteDatabase,
    private readonly settingsPath: string,
    private readonly log: Logger,
  ) {
    this.fileSettings = loadFileSettings(settingsPath, log);
    this.snapshot = this.read();
  }

  public load(): AppSettingsSnapshot {
    return this.snapshot;
  }

  /**
   * Re-read the snapshot from the database.
   *
   * The snapshot is cached, which is what keeps a screen that reads it on every
   * paint from hitting the database. Anything that writes settings *behind* this
   * service - the first-run setup writes them straight to the store - has to say
   * so, or every later read sees the values that were cached before it ran.
   */
  public refresh(): AppSettingsSnapshot {
    this.snapshot = this.read();
    return this.snapshot;
  }

  public file(): FileSettings {
    return this.fileSettings;
  }

  /** Record the time of the last successful backup for the backup screen. */
  public noteBackup(atIso: string): void {
    this.fileSettings = { ...this.fileSettings, lastBackupAtIso: atIso };
    this.persistFile();
    this.snapshot = this.read();
  }

  public update(patch: UpdateSettings): AppSettingsSnapshot {
    let filePatch: Partial<FileSettings> = {};
    let touchedFile = false;

    for (const [key, value] of Object.entries(patch) as [
      keyof UpdateSettings,
      unknown,
    ][]) {
      if (value === undefined) continue;

      switch (key) {
        case "backupDirectory":
          filePatch = {
            ...filePatch,
            backupDirectory: typeof value === "string" ? value : "",
          };
          touchedFile = true;
          break;
        case "backupKeepCount":
          filePatch = { ...filePatch, backupKeepCount: coerceNumber(value, 30, 1, 3650) };
          touchedFile = true;
          break;
        case "dailyBackupEnabled":
          filePatch = { ...filePatch, dailyBackupEnabled: coerceBoolean(value, true) };
          touchedFile = true;
          break;
        case "dailyBackupHour":
          filePatch = { ...filePatch, dailyBackupHour: coerceNumber(value, 2, 0, 23) };
          touchedFile = true;
          break;
        case "donationRatePercent":
          // The donation is a percentage of net profit. The partners' own
          // shares live with the partners, and the two together with the
          // donation have to come to 100% - which is checked when a partner
          // is saved and again when the split is calculated.
          break;
      }
    }

    if (touchedFile) {
      this.fileSettings = { ...this.fileSettings, ...filePatch };
      this.persistFile();
    }

    // The database-backed half: every writable field the file does not own goes
    // into the `settings` table, so it rolls back with the data it describes.
    //
    // `isWritableField` is the single source of truth for "may this be written
    // at all". That is what keeps the four file-owned backup settings above out
    // of the database, and what stops a key nobody recognises from being stored
    // under its own name.
    for (const [key, value] of Object.entries(patch) as [keyof UpdateSettings, unknown][]) {
      if (value === undefined) continue;
      if (!isWritableField(key)) continue;

      const settingKey = settingKeyFor(key);
      if (settingKey === null) continue;

      writeSetting(this.db, settingKey, serialiseSettingValue(value));
    }

    this.snapshot = this.read();
    return this.snapshot;
  }

  private persistFile(): void {
    saveFileSettings(this.settingsPath, this.fileSettings, this.log);
  }

  private read(): AppSettingsSnapshot {
    const snapshot = loadSnapshot(this.db, {
      backupDirectory: this.fileSettings.backupDirectory,
      backupKeepCount: this.fileSettings.backupKeepCount,
      dailyBackupEnabled: this.fileSettings.dailyBackupEnabled,
      dailyBackupHour: this.fileSettings.dailyBackupHour,
    });

    return { ...snapshot, companyLogoDataUrl: this.readLogo(snapshot.companyLogoPath) };
  }

  /**
   * Inline the company logo as a data URL.
   *
   * Only the path the shopkeeper chose is read - the renderer cannot ask for an
   * arbitrary file. The image is embedded rather than linked because printed
   * documents are rendered in a separate sandboxed window that has no access to
   * the filesystem, so a `file://` reference would silently print as a broken
   * image.
   *
   * The size cap matters: the snapshot is refreshed on every settings read and
   * travels over IPC, so an unbounded image would bloat every call. 512 KB is
   * far more than a print-resolution logo needs.
   */
  private readLogo(path: string): string | null {
    if (path.trim().length === 0) return null;

    const extension = extname(path).toLowerCase();
    const mime =
      extension === ".png"
        ? "image/png"
        : extension === ".jpg" || extension === ".jpeg"
          ? "image/jpeg"
          : extension === ".webp"
            ? "image/webp"
            : null;

    if (mime === null) {
      this.log.warn("Ignoring company logo: unsupported image type", { path, extension });
      return null;
    }

    try {
      const { size } = statSync(path);
      if (size > MAX_LOGO_BYTES) {
        this.log.warn("Ignoring company logo: file is too large", { path, sizeBytes: size });
        return null;
      }
      return `data:${mime};base64,${readFileSync(path).toString("base64")}`;
    } catch (error) {
      this.log.warn("Could not read the company logo", {
        path,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}

/** Values are stored as text; booleans as 1/0 and numbers as plain digits. */
function serialiseSettingValue(value: unknown): string {
  if (typeof value === "boolean") return value ? "1" : "0";
  return String(value);
}

export { DEFAULT_SNAPSHOT, SETTING_KEYS, getSetting };