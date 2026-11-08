/**
 * Application context: resolved paths, the open database, the encryption state,
 * and the logger.
 *
 * Assembled once at startup so no module has to guess where data lives or
 * which connection to use. The database is opened through the encrypted path so
 * the key is applied before any pragma, and the key itself never leaves this
 * module except to the backup code that needs it to read a backup back.
 */

import { existsSync, mkdirSync, renameSync } from "node:fs";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import { app } from "electron";
import { type SqliteDatabase, closeDatabase } from "../data/connection";
import {
  type EncryptionState,
  openEncryptedDatabase,
  resolveEncryptionKey,
} from "../data/encrypted-connection";
import { createLogger, type Logger } from "./logger";

/**
 * Environment variable that relocates the whole data folder.
 *
 * Needed for two real situations: an automated end-to-end run, which must not
 * touch the shop's live database, and a "portable" install where the shopkeeper
 * wants the data on a USB stick so it travels with the machine. Set it to an
 * absolute directory; anything else is ignored so a stray value cannot silently
 * scatter data across the disk.
 */
export const USER_DATA_ENV_VAR = "EYERSTOCK_DATA_DIR";

/**
 * The variable earlier builds used, still honoured so an existing test harness
 * or a documented setup keeps working after the rename.
 */
const LEGACY_USER_DATA_ENV_VARS = ["MINHA_DATA_DIR"] as const;

/** Database file name inside the data folder. */
const DATABASE_FILE = "eyerstock.db";

/** The name this app shipped under before it was renamed to EyerStock. */
const LEGACY_PRODUCT_NAME = "Minha Inventory";

/** The database file name that product used. */
const LEGACY_DATABASE_FILE = "minha-inventory.db";

export interface AppPaths {
  readonly userData: string;
  readonly databasePath: string;
  readonly logsDir: string;
  readonly defaultBackupDir: string;
  readonly settingsFile: string;
  readonly exportsDir: string;
  /** Profile pictures, copied here so the database only ever holds a name. */
  readonly avatarsDir: string;
}

export interface AppContext {
  readonly paths: AppPaths;
  /**
   * The live connection.
   *
   * A getter, not a captured value: restoring a backup closes the connection,
   * replaces the file underneath it and opens a new one, and every holder of
   * the context must see the current handle rather than the one it first saw.
   */
  readonly db: SqliteDatabase;
  readonly log: Logger;
  /** Cipher key, kept here so backup verification can read a backup back. */
  readonly databaseKey: string;
  readonly encryption: EncryptionState;
  /** True while a connection is open. */
  isOpen(): boolean;
  /**
   * Close the connection, leaving the context usable.
   *
   * Windows refuses to rename over an open database file, so this has to
   * happen before a restore can replace the file at all.
   */
  closeDb(): void;
  /** Reopen the connection to the file at its current path. */
  openDb(): void;
  dispose(): void;
}

export function resolvePaths(userDataDir: string): AppPaths {
  return {
    userData: userDataDir,
    databasePath: join(userDataDir, DATABASE_FILE),
    logsDir: join(userDataDir, "logs"),
    defaultBackupDir: join(userDataDir, "backups"),
    settingsFile: join(userDataDir, "settings.json"),
    exportsDir: join(userDataDir, "exports"),
    avatarsDir: join(userDataDir, "avatars"),
  };
}

/**
 * Where the data folder lives.
 *
 * `EYERSTOCK_DATA_DIR` wins when it holds an absolute path (the pre-rename
 * `MINHA_DATA_DIR` is still honoured); otherwise the platform location Electron
 * picks for the app is used.
 */
export function resolveUserDataDir(
  env: NodeJS.ProcessEnv = process.env,
  fallback: string = app.getPath("userData"),
): string {
  return explicitDataDirOverride(env) ?? fallback;
}

/**
 * The explicitly requested data folder, or null when none was requested.
 *
 * Separate from {@link resolveUserDataDir} because that one falls back to
 * `app.getPath("userData")`, which is a question about application state and
 * should not be asked while the app is still starting. The main process uses
 * this form to redirect Chromium's own directory before the app is ready.
 */
export function explicitDataDirOverride(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const name of [USER_DATA_ENV_VAR, ...LEGACY_USER_DATA_ENV_VARS]) {
    const override = env[name];
    if (override === undefined || override.trim().length === 0) continue;
    if (!isAbsolute(override)) continue;
    return resolvePath(override);
  }
  return null;
}

/**
 * Carry a pre-rename data folder over to the new one.
 *
 * Electron derives the data folder from the product name, so renaming the
 * product moves it. Without this, every existing shop would open to an empty
 * database and appear to have lost its whole history - the old folder would sit
 * untouched beside the new one.
 *
 * The move is only attempted when the destination does not exist, so it can
 * never overwrite live data, and the old folder is left in place if the move
 * fails (a file locked by a backup tool, say) rather than being removed.
 */
export function migrateLegacyDataDirectory(
  targetUserDataDir: string,
  appDataDir: string,
  log: Logger,
): boolean {
  const legacyDir = join(appDataDir, LEGACY_PRODUCT_NAME);

  if (!existsSync(legacyDir)) return false;
  if (existsSync(targetUserDataDir)) return false;

  try {
    // Rename first: it is atomic within a volume and does not copy a database
    // that might be changing underneath us.
    renameSync(legacyDir, targetUserDataDir);
    log.info("Moved the data folder to the new product name", {
      from: legacyDir,
      to: targetUserDataDir,
    });
  } catch {
    log.warn("Could not move the previous data folder across; it was left where it is", {
      from: legacyDir,
    });
    return false;
  }

  renameLegacyDatabaseFile(targetUserDataDir, log);
  return true;
}

/** Rename the pre-rename database file inside an already-migrated folder. */
function renameLegacyDatabaseFile(userDataDir: string, log: Logger): void {
  const legacyDatabase = join(userDataDir, LEGACY_DATABASE_FILE);
  if (!existsSync(legacyDatabase)) return;

  const target = join(userDataDir, DATABASE_FILE);
  if (existsSync(target)) return;

  try {
    renameSync(legacyDatabase, target);
    log.info("Renamed the database file", { from: legacyDatabase, to: target });
  } catch {
    log.warn("Could not rename the previous database file; it was left where it is");
  }
}

export function createAppContext(userDataDir: string = resolveUserDataDir()): AppContext {
  const paths = resolvePaths(userDataDir);
  const log = createLogger(paths.logsDir);
  mkdirSync(paths.defaultBackupDir, { recursive: true });
  mkdirSync(paths.exportsDir, { recursive: true });

  const { key, state } = resolveEncryptionKey(userDataDir);
  let handle: SqliteDatabase | null = openEncryptedDatabase(paths.databasePath, key);

  if (state.warning !== null) {
    log.warn("Database encryption is using the weaker key-file mode", { detail: state.warning });
  }

  function close(): void {
    if (handle === null) return;
    closeDatabase(handle);
    handle = null;
  }

  function reopen(): void {
    if (handle !== null) return;
    handle = openEncryptedDatabase(paths.databasePath, key);
  }

  return {
    paths,
    get db(): SqliteDatabase {
      if (handle === null) {
        throw new Error("The database connection is closed.");
      }
      return handle;
    },
    log,
    databaseKey: key,
    encryption: state,
    isOpen: () => handle !== null,
    closeDb: close,
    openDb: reopen,
    dispose: close,
  };
}
