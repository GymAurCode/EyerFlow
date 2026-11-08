import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openInMemoryDatabase, type SqliteDatabase } from "../src/data/connection";
import { runMigrations } from "../src/data/migrator";
import { migrations } from "../src/data/migrations";

export interface TempWorkspace {
  readonly dir: string;
  readonly dbPath: string;
  cleanup(): void;
}

export function createTempWorkspace(prefix = "eyerstock-test-"): TempWorkspace {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return {
    dir,
    dbPath: join(dir, "test.db"),
    cleanup() {
      // Windows keeps a handle on the file briefly after close; a failure to
      // remove a temp directory must not fail an otherwise passing test.
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        /* best effort */
      }
    },
  };
}

export function freshDb(): SqliteDatabase {
  return openInMemoryDatabase();
}

/**
 * Build a genuine v1 database and fill it with shop data.
 *
 * Uses the real migration 1 body rather than a hand-written subset, so this
 * fixture is byte-for-byte what a shop on v1 actually has. A subset would pass
 * migration tests while proving nothing: migration 1 would never run, and the
 * columns it introduces would silently be missing.
 */
export function seedLegacyV1Database(db: SqliteDatabase): void {
  const v1 = migrations.find((migration) => migration.version === 1);
  if (v1 === undefined) {
    throw new Error("Migration 1 is missing; the legacy fixture cannot be built");
  }

  runMigrations(db, [v1]);

  const now = "2024-01-01T00:00:00.000Z";
  const insertParty = db.prepare(
    `INSERT INTO parties (code, name, kind, phone, opening_balance, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  insertParty.run("C-0001", "Al Rawi Trading", "customer", "+971500000001", 25_000, now, now);
  insertParty.run("S-0001", "Bluewave Filters LLC", "supplier", "+971500000002", 0, now, now);

  const insertProduct = db.prepare(
    `INSERT INTO products (sku, name, quantity_milli, average_cost_fils, sale_price_fils, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  insertProduct.run("RO-5STAGE", "5-Stage RO System", 10_000, 45_000, 85_000, now, now);
  insertProduct.run("FIL-CARBON", "Carbon Filter 10in", 24_000, 1_200, 2_500, now, now);
  insertProduct.run("PUMP-BOOST", "Booster Pump 0.5HP", 4_000, 18_000, 32_000, now, now);
}

/** Run the full migration list against an in-memory database. */
export function migrateInMemory(db: SqliteDatabase): void {
  runMigrations(db, migrations);
}

/** Write a file that is deliberately not a SQLite database. */
export function writeGarbageFile(path: string): void {
  writeFileSync(path, "this is not a sqlite file", "utf8");
}

/**
 * Backdate a file's timestamps so backup-pruning order is deterministic.
 *
 * Windows mtime resolution is coarse enough that files written in a tight loop
 * can share a timestamp, which would make the prune test flaky.
 */
export function backdateFile(path: string, epochMs: number): void {
  const seconds = epochMs / 1000;
  utimesSync(path, seconds, seconds);
}
