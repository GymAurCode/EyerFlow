/**
 * Backup and restore.
 *
 * Backups use SQLite's online backup API, which produces a consistent snapshot
 * even while the app is writing. Copying the file with the filesystem instead
 * would capture a torn WAL and produce an unrestorable backup, which is the most
 * common way offline apps lose data.
 *
 * Because the live database is SQLCipher-encrypted, a backup taken through the
 * API is encrypted with the same key. Every read-back path here therefore takes
 * the key: a backup cannot be opened by another tool, which is the point, but it
 * does mean restoring needs the same key file the original machine used.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { SqliteDatabase } from "./connection";
import { checkIntegrity, openForInspection } from "./connection";

export interface BackupResult {
  readonly path: string;
  readonly sizeBytes: number;
  readonly createdAtIso: string;
}

/** Files that make up a live database and must be copied alongside it. */
const DATABASE_SIDECARS = ["-wal", "-shm", "-journal"] as const;

/** SQL string literals need embedded quotes doubled, not escaped. */
function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Take a consistent backup of `db` at `destinationPath`.
 *
 * The integrity check runs on the source first; backing up a corrupt database
 * would silently propagate the corruption into every future restore.
 *
 * The copy is made with `VACUUM INTO`, not `db.backup()`. This build's driver
 * encrypts pages with ChaCha20 and `backup()` only accepts a destination path,
 * which it opens with no key; SQLite then refuses the copy outright with
 * "backup is not supported with incompatible source and target databases". Had
 * it succeeded, the result would have been an unencrypted copy of the shop's
 * ledger sitting on disk. `VACUUM INTO` writes through the same codec as the
 * source, and takes a transaction internally, so it is both encrypted with the
 * same key and a consistent snapshot rather than a page-by-page copy.
 *
 * `key` is the passphrase the source was opened with. It has to be passed in
 * rather than read back, because this build does not allow `PRAGMA key` to be
 * read - attempting it is a SQL logic error, so there is no way for the backup
 * code to discover the key from the handle.
 */
export async function createBackup(
  db: SqliteDatabase,
  destinationPath: string,
  key: string | null = null,
): Promise<BackupResult> {
  const integrity = checkIntegrity(db);
  if (!integrity.ok) {
    throw new Error(
      `Refusing to back up a corrupt database: integrity_check returned "${integrity.detail}"`,
    );
  }

  mkdirSync(dirname(destinationPath), { recursive: true });

  if (key === null) {
    // An unencrypted source: the backup API is the right tool and produces a
    // plain, readable copy, which is what the verify path expects for one.
    await db.backup(destinationPath);
  } else {
    // VACUUM INTO refuses to overwrite, and a leftover file from an interrupted
    // attempt would otherwise be left in place pretending to be the new backup.
    if (existsSync(destinationPath)) unlinkSync(destinationPath);
    for (const sidecar of ["-wal", "-shm", "-journal"] as const) {
      if (existsSync(`${destinationPath}${sidecar}`)) unlinkSync(`${destinationPath}${sidecar}`);
    }

    db.exec(`VACUUM INTO ${quote(destinationPath)}`);
  }

  const stats = statSync(destinationPath);
  if (stats.size === 0) {
    throw new Error(`Backup at ${destinationPath} is empty`);
  }

  return { path: destinationPath, sizeBytes: stats.size, createdAtIso: new Date().toISOString() };
}

export interface RestoreVerification {
  readonly ok: boolean;
  readonly message: string;
  readonly schemaVersion: number;
}

/**
 * Verify a candidate restore file before it replaces live data.
 *
 * Opens the file read-only and checks both integrity and that it carries our
 * schema, so pointing the app at a random SQLite file fails with a clear message
 * instead of a wall of "no such table" errors.
 *
 * `key` is the SQLCipher passphrase for an encrypted backup; pass `null` for a
 * plain SQLite file. Production always has a key, so `null` exists only for the
 * migration tests, which exercise unencrypted databases.
 */
export function verifyBackupFile(
  backupPath: string,
  key: string | null = null,
): RestoreVerification {
  if (!existsSync(backupPath)) {
    return { ok: false, message: `Backup file not found: ${backupPath}`, schemaVersion: 0 };
  }

  let probe: SqliteDatabase;
  try {
    probe = openForInspection(backupPath, key);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      message: `Not a readable SQLite database: ${detail}`,
      schemaVersion: 0,
    };
  }

  try {
    // better-sqlite3 opens lazily: a non-database file (or a wrong cipher key) is
    // only detected once a statement runs, so the check itself has to be guarded.
    try {
      checkIntegrity(probe);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        message:
          key === null
            ? `Not a readable SQLite database: ${detail}`
            : `This backup was encrypted with a different key, so it cannot be read on this machine: ${detail}`,
        schemaVersion: 0,
      };
    }

    const integrity = checkIntegrity(probe);
    if (!integrity.ok) {
      return {
        ok: false,
        message: `Backup is corrupt (integrity_check: ${integrity.detail})`,
        schemaVersion: 0,
      };
    }

    const migrationsTable = probe
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
      .get() as { name?: unknown } | undefined;

    if (migrationsTable === undefined) {
      return {
        ok: false,
        message: "Valid database, but not an EyerStock backup (no schema_migrations table).",
        schemaVersion: 0,
      };
    }

    const row = probe
      .prepare(
        "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations WHERE applied_at IS NOT NULL",
      )
      .get() as { version?: unknown } | undefined;

    const schemaVersion = typeof row?.version === "number" ? row.version : 0;

    return {
      ok: true,
      message: `Backup verified. Schema version ${schemaVersion}.`,
      schemaVersion,
    };
  } finally {
    probe.close();
  }
}

export interface RestoreOptions {
  /**
   * Schema version the app currently expects. A backup from a newer app build
   * is rejected so an older build cannot clobber data it cannot understand.
   */
  readonly expectedSchemaVersion: number;
  /** Where to stash the current database before overwriting it. */
  readonly safetyBackupPath?: string;
}

export interface RestoreOutcome {
  readonly restored: BackupResult;
  readonly verification: RestoreVerification;
  readonly safetyBackupPath: string | null;
}

/**
 * Restore a backup over the live database.
 *
 * The safety copy is taken first, and the replacement goes via a rename so a
 * failure part-way cannot leave a half-written live database.
 */
export function restoreBackup(
  currentDbPath: string,
  backupPath: string,
  options: RestoreOptions,
  key: string | null = null,
): RestoreOutcome {
  const verification = verifyBackupFile(backupPath, key);
  if (!verification.ok) {
    throw new Error(verification.message);
  }

  if (verification.schemaVersion > options.expectedSchemaVersion) {
    throw new Error(
      `This backup was made by a newer version of the app ` +
        `(schema ${verification.schemaVersion}, this build supports ${options.expectedSchemaVersion}). ` +
        `Update the app before restoring it.`,
    );
  }

  let safetyBackupPath: string | null = null;

  if (existsSync(currentDbPath)) {
    safetyBackupPath = options.safetyBackupPath ?? `${currentDbPath}.prerestore-${Date.now()}`;
    copyFileSync(currentDbPath, safetyBackupPath);
    for (const suffix of DATABASE_SIDECARS) {
      const sidecar = `${currentDbPath}${suffix}`;
      if (existsSync(sidecar)) {
        copyFileSync(sidecar, `${safetyBackupPath}${suffix}`);
      }
    }
  }

  const staged = `${currentDbPath}.restoring`;
  copyFileSync(backupPath, staged);
  renameSync(staged, currentDbPath);

  const stats = statSync(currentDbPath);
  return {
    restored: {
      path: currentDbPath,
      sizeBytes: stats.size,
      createdAtIso: new Date().toISOString(),
    },
    verification,
    safetyBackupPath,
  };
}

/**
 * Delete the oldest backups beyond `keepCount`.
 *
 * Retention is enforced on every backup run so a backup folder on a USB stick
 * or a synced OneDrive folder cannot grow without bound.
 */
export function pruneBackups(directory: string, keepCount: number): string[] {
  if (!Number.isInteger(keepCount) || keepCount < 1) {
    throw new RangeError(`keepCount must be a positive integer, received ${String(keepCount)}`);
  }
  if (!existsSync(directory)) return [];

  const candidates = readdirSync(directory)
    .filter((name) => name.toLowerCase().endsWith(".db"))
    .map((name) => {
      const path = join(directory, name);
      return { path, mtimeMs: statSync(path).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  const doomed = candidates.slice(keepCount);
  for (const file of doomed) {
    unlinkSync(file.path);
  }

  return doomed.map((file) => basename(file.path));
}

export function buildBackupFilename(appPrefix: string, when: Date): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
  const stamp =
    `${when.getFullYear()}${pad(when.getMonth() + 1)}${pad(when.getDate())}` +
    `-${pad(when.getHours())}${pad(when.getMinutes())}${pad(when.getSeconds())}`;
  return `${appPrefix}-${stamp}.db`;
}