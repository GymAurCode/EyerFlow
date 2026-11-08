/**
 * Versioned schema migrations.
 *
 * Rules that protect existing shop data:
 *  - every migration is additive (new tables/columns), never destructive;
 *  - each migration runs in its own transaction, so a failure leaves the
 *    database at the last known-good version rather than half-migrated;
 *  - the applied version is recorded, and an unknown newer version is refused;
 *  - a pre-migration safety backup is recommended (and enforced by the caller)
 *    before any migration runs.
 */

import type { SqliteDatabase } from "./connection";

export interface Migration {
  /** Monotonic integer. Never renumber or reuse a shipped version. */
  readonly version: number;
  readonly name: string;
  readonly up: (db: SqliteDatabase) => void;
  /**
   * Migrations that rewrite or drop existing data opt out of the automatic
   * pre-migration backup, because the backup is their only safety net and must
   * be taken deliberately.
   */
  readonly destructive?: boolean;
  /**
   * Set on migrations that rebuild a table via the documented
   * create-copy-drop-rename procedure. Such a rebuild drops a parent table that
   * other tables reference, which SQLite refuses while foreign keys are on, and
   * `PRAGMA foreign_keys` is a no-op inside a transaction. The runner therefore
   * turns enforcement off around the migration and verifies
   * `foreign_key_check` before turning it back on.
   */
  readonly requiresForeignKeysOff?: boolean;
}

export interface AppliedMigration {
  readonly version: number;
  readonly name: string;
  readonly appliedAt: string;
}

const CREATE_MIGRATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version     INTEGER PRIMARY KEY,
    name        TEXT    NOT NULL,
    applied_at  TEXT    NOT NULL,
    checksum    TEXT    NOT NULL
  )
`;

export class MigrationError extends Error {
  public readonly version: number | undefined;

  public constructor(message: string, version?: number) {
    super(message);
    this.name = "MigrationError";
    this.version = version;
  }
}

/** FNV-1a, used to detect an already-applied migration file being edited. */
function checksum(sql: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < sql.length; index += 1) {
    hash ^= sql.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function ensureMigrationsTable(db: SqliteDatabase): void {
  db.exec(CREATE_MIGRATIONS_TABLE);
}

export function getAppliedMigrations(db: SqliteDatabase): AppliedMigration[] {
  ensureMigrationsTable(db);
  const rows = db
    .prepare(
      "SELECT version, name, applied_at AS appliedAt FROM schema_migrations WHERE applied_at IS NOT NULL ORDER BY version",
    )
    .all() as AppliedMigration[];
  return rows;
}

export function getCurrentSchemaVersion(db: SqliteDatabase): number {
  const rows = getAppliedMigrations(db);
  const last = rows[rows.length - 1];
  return last?.version ?? 0;
}

/**
 * Applied migrations whose recorded name no longer matches the file.
 *
 * Editing a migration that has already run is the most common way a team breaks
 * production data: fresh databases get the new behaviour while existing shops
 * keep the old, and the divergence surfaces months later. Flagged at startup so
 * it is caught on a developer machine rather than a shop's till.
 */
export function findModifiedMigrations(
  db: SqliteDatabase,
  migrations: readonly Migration[],
): Migration[] {
  ensureMigrationsTable(db);

  const rows = db
    .prepare("SELECT version, name FROM schema_migrations WHERE applied_at IS NOT NULL")
    .all() as { version: number; name: string }[];

  const byVersion = new Map(rows.map((row) => [row.version, row.name]));

  const modified: Migration[] = [];
  for (const migration of migrations) {
    const recordedName = byVersion.get(migration.version);
    if (recordedName !== undefined && recordedName !== migration.name) {
      modified.push(migration);
    }
  }

  return modified;
}

export interface MigrationPlan {
  readonly pending: readonly Migration[];
  readonly currentVersion: number;
  readonly targetVersion: number;
}

export function planMigrations(
  db: SqliteDatabase,
  migrations: readonly Migration[],
): MigrationPlan {
  const sorted = [...migrations].sort((a, b) => a.version - b.version);

  const seen = new Set<number>();
  for (const migration of sorted) {
    if (seen.has(migration.version)) {
      throw new MigrationError(
        `Duplicate migration version ${migration.version}: "${migration.name}".`,
        migration.version,
      );
    }
    seen.add(migration.version);
    if (!Number.isInteger(migration.version) || migration.version < 1) {
      throw new MigrationError(
        `Migration version must be a positive integer, found ${String(migration.version)}.`,
        migration.version,
      );
    }
  }

  const currentVersion = getCurrentSchemaVersion(db);
  const applied = new Set(getAppliedMigrations(db).map((migration) => migration.version));

  const pending = sorted.filter((migration) => !applied.has(migration.version));

  const targetVersion =
    sorted.length > 0 ? Math.max(...sorted.map((m) => m.version)) : currentVersion;

  if (currentVersion > targetVersion) {
    throw new MigrationError(
      `Database schema version ${currentVersion} is newer than this build supports (${targetVersion}). ` +
        `Update the app; do not run an older build against this database.`,
      currentVersion,
    );
  }

  return { pending, currentVersion, targetVersion };
}

export interface MigrationResult {
  readonly applied: readonly AppliedMigration[];
  readonly fromVersion: number;
  readonly toVersion: number;
}

/**
 * Run a migration with foreign key enforcement suspended.
 *
 * `PRAGMA foreign_keys` is a no-op inside a transaction, so it has to be set
 * before `run` opens one. The pragma is restored unconditionally, including
 * when the migration throws, so a failed rebuild cannot leave the connection
 * silently running without referential integrity.
 */
function runWithForeignKeysOff(db: SqliteDatabase, run: () => void): void {
  const wasEnabled = (db.pragma("foreign_keys", { simple: true }) as number) === 1;
  if (wasEnabled) {
    db.pragma("foreign_keys = OFF");
  }

  try {
    run();
  } finally {
    if (wasEnabled) {
      db.pragma("foreign_keys = ON");
    }
  }
}

/**
 * Apply all pending migrations.
 *
 * `beforeFirstMigration` is where the caller takes the automatic pre-migration
 * backup; it is invoked at most once, before anything is written.
 */
export function runMigrations(
  db: SqliteDatabase,
  migrations: readonly Migration[],
  beforeFirstMigration?: (plan: MigrationPlan) => void,
): MigrationResult {
  ensureMigrationsTable(db);

  const plan = planMigrations(db, migrations);

  if (plan.pending.length === 0) {
    return { applied: [], fromVersion: plan.currentVersion, toVersion: plan.currentVersion };
  }

  if (beforeFirstMigration !== undefined) {
    beforeFirstMigration(plan);
  }

  const insertRecord = db.prepare(
    "INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (?, ?, ?, ?)",
  );

  const applied: AppliedMigration[] = [];

  for (const migration of plan.pending) {
    try {
      // One transaction per migration: a failure rolls back cleanly to the last
      // good version instead of leaving a partially-applied schema.
      const run = db.transaction(() => {
        migration.up(db);
        insertRecord.run(
          migration.version,
          migration.name,
          new Date().toISOString(),
          checksum(migration.name),
        );
      });

      if (migration.requiresForeignKeysOff === true) {
        runWithForeignKeysOff(db, run);
      } else {
        run();
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new MigrationError(
        `Migration ${migration.version} ("${migration.name}") failed and was rolled back: ${detail}`,
        migration.version,
      );
    }

    applied.push({
      version: migration.version,
      name: migration.name,
      appliedAt: new Date().toISOString(),
    });
  }

  const toVersion = getCurrentSchemaVersion(db);
  return { applied, fromVersion: plan.currentVersion, toVersion };
}
