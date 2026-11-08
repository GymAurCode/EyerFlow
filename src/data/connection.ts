/**
 * SQLite connection helpers shared by the encrypted and in-memory paths.
 *
 * The live database is opened by `encrypted-connection.ts`, which applies the
 * SQLCipher key before anything else. This module owns the pragma policy, the
 * integrity check, and the plain in-memory connection used by tests.
 *
 * `SqliteDatabase` is the `better-sqlite3` interface. The SQLCipher build is a
 * drop-in replacement with the same API, so repositories are typed against this
 * alias and work with either connection.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type BetterSqlite3 from "better-sqlite3";

export type SqliteDatabase = BetterSqlite3.Database;

/**
 * Pragmas applied to every connection.
 *
 * WAL keeps the UI responsive during a long backup or import. `foreign_keys` is
 * off by default in SQLite and must be enabled per connection or referential
 * integrity is silently unenforced.
 */
const PRAGMAS: readonly { readonly name: string; readonly value: string }[] = [
  { name: "journal_mode", value: "WAL" },
  { name: "foreign_keys", value: "ON" },
  { name: "synchronous", value: "NORMAL" },
  { name: "busy_timeout", value: "5000" },
  { name: "trusted_schema", value: "OFF" },
];

/** Resolve a possibly-relative DB path to an absolute one. */
export function resolveDatabasePath(dbPath: string): string {
  return isAbsolute(dbPath) ? dbPath : resolve(process.cwd(), dbPath);
}

/** Apply the shared pragma policy. `journal_mode` is skipped for memory DBs. */
export function applyPragmas(db: SqliteDatabase, allowJournalMode = true): void {
  for (const pragma of PRAGMAS) {
    if (pragma.name === "journal_mode" && !allowJournalMode) continue;
    db.pragma(`${pragma.name} = ${pragma.value}`);
  }
}

/**
 * Open an in-memory database with the same pragmas.
 *
 * Used by the test suite and by any preview path that must never touch the real
 * shop data. Cannot be encrypted: SQLCipher has no key support for in-memory
 * databases, which is fine because no data survives the process.
 */
/**
 * Open an unencrypted database.
 *
 * Used only by the test suite and by restore-verification probes. Production
 * startup always goes through `openEncryptedDatabase`.
 */
export function openDatabase(dbPath: string): SqliteDatabase {
  const absolutePath = resolveDatabasePath(dbPath);
  ensureDirectoryFor(absolutePath);

  const Database = loadDriver();
  const db = new Database(absolutePath, {
    readonly: false,
    fileMustExist: false,
    ...driverOptions(),
  }) as SqliteDatabase;

  applyPragmas(db);

  return db;
}

export function openInMemoryDatabase(): SqliteDatabase {
  const Database = loadDriver();
  const db = new Database(":memory:", driverOptions()) as SqliteDatabase;
  applyPragmas(db, false);
  return db;
}

/**
 * Open a handle with a cipher key applied immediately.
 *
 * `fileMustExist` is on by default because restore verification uses this to
 * peek inside a candidate backup, where a missing file must be an error rather
 * than a silently created empty database. Startup passes `false` so a first run
 * creates the file; verification passes the default.
 */
export function openForInspection(
  path: string,
  key: string | null,
  readonly = true,
  fileMustExist = true,
): SqliteDatabase {
  const Database = loadDriver();
  const db = new Database(path, { readonly, fileMustExist, ...driverOptions() }) as SqliteDatabase;

  if (key !== null) {
    db.pragma(`key = '${key.replace(/'/g, "''")}'`);
  }

  return db;
}

type DatabaseConstructor = new (path: string, options?: unknown) => unknown;

interface DriverModule {
  default?: DatabaseConstructor;
}

/**
 * Directory holding the side-by-side native bindings produced by
 * `scripts/build-native.js`.
 *
 * The in-tree copy inside `node_modules` is always the Electron build, because
 * that is what the app and the packaged installer load. Plain Node - vitest, the
 * seed benchmark, the CLI scripts - needs the Node-ABI build instead, which
 * lives here. See the script for the full rationale.
 */
const SIDECAR_BINDING_DIR = resolve(__dirname, "..", "..", "build-native");

/**
 * Choose the native binding for the current process.
 *
 * Returns `undefined` for Electron (the in-tree binding is already the right
 * one) and for plain Node when the sidecar has not been built yet, in which
 * case better-sqlite3 falls back to its default `bindings()` lookup and the
 * caller gets the driver's own clear ABI error message.
 */
function resolveNativeBinding(): string | undefined {
  if (process.versions.electron) return undefined;

  const nodeBinding = resolve(SIDECAR_BINDING_DIR, "better_sqlite3.node.node");
  return existsSync(nodeBinding) ? nodeBinding : undefined;
}

/**
 * Load the native driver lazily.
 *
 * Required rather than imported so importing this module never pulls in the
 * native binding: the browser-facing type graph must stay free of it. The
 * package is CommonJS and exports the constructor itself, but transpilers
 * differ in whether they surface a `.default` interop wrapper, so both shapes
 * are handled.
 */
function loadDriver(): DatabaseConstructor {
  const loaded: unknown = require("better-sqlite3-multiple-ciphers");

  if (typeof loaded === "function") return loaded as DatabaseConstructor;

  const interop = (loaded as DriverModule).default;
  if (typeof interop === "function") return interop;

  throw new Error("The SQLite driver could not be loaded.");
}

/** Options handed to the driver on every open, including the ABI binding. */
function driverOptions(): Record<string, unknown> {
  const nativeBinding = resolveNativeBinding();
  return nativeBinding === undefined ? {} : { nativeBinding };
}

export interface IntegrityResult {
  readonly ok: boolean;
  readonly detail: string;
}

/**
 * Run SQLite's own integrity check. Used before trusting a restored backup and
 * before opening a database recovered from an unclean shutdown.
 */
export function checkIntegrity(db: SqliteDatabase): IntegrityResult {
  const rows = db.pragma("integrity_check") as { integrity_check?: unknown }[];
  const first = rows[0];
  const detail =
    first !== undefined && typeof first.integrity_check === "string"
      ? first.integrity_check
      : "unknown";

  return { ok: detail === "ok", detail };
}

export function closeDatabase(db: SqliteDatabase): void {
  if (db.open) {
    db.close();
  }
}

export function ensureDirectoryFor(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}

/** SQL string literals need embedded quotes doubled, not escaped. */
function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

interface SchemaObject {
  readonly type: string;
  readonly name: string;
  readonly sql: string | null;
}

/**
 * Copy an entire database from one open connection into another.
 *
 * This exists because of how the cipher in this build behaves: SQLite's backup
 * API refuses to copy between an encrypted and a plain database, `ATTACH` of a
 * plain database from an encrypted connection fails the same way, and there is no
 * `sqlcipher_export` to fall back on. Every other route between the two is
 * closed, so the only way to re-key a database is to move it row by row through
 * JavaScript, where each connection only ever sees its own cipher state.
 *
 * Rows are streamed with `iterate()` and inserted inside a single transaction,
 * so memory stays bounded by one row rather than by the size of the database,
 * and a failure part-way through rolls the destination back to empty.
 *
 * Order matters: tables, then their rows, then `sqlite_sequence`, then indexes,
 * then triggers and views. Indexes and views cannot be created before the data
 * they cover exists. AUTOINCREMENT counters need no explicit handling - SQLite
 * raises `sqlite_sequence` automatically when a row is inserted with an explicit
 * rowid larger than the stored value, which is what `SELECT *` supplies.
 */
export function copyDatabaseContents(
  source: SqliteDatabase,
  destination: SqliteDatabase,
): void {
  const objects = source
    .prepare(
      `SELECT type, name, sql FROM sqlite_master
        WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
        ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, rowid`,
    )
    .all() as SchemaObject[];

  const tables = objects.filter((object) => object.type === "table");
  const indexes = objects.filter((object) => object.type === "index");
  const late = objects.filter((object) => object.type === "trigger" || object.type === "view");

  for (const table of tables) {
    destination.exec(table.sql ?? "");
  }

  const copy = destination.transaction((): void => {
    for (const table of tables) {
      const quoted = quote(table.name);

      // Column names are read from the schema rather than inferred from a row,
      // so an empty table is handled identically to a populated one.
      const columns = (
        source
          .prepare(`SELECT name FROM pragma_table_info(${quote(table.name)})`)
          .all() as { name: string }[]
      ).map((column) => column.name);

      if (columns.length === 0) continue;

      // Named placeholders and an object binding, rather than positional
      // arguments: better-sqlite3's positional overloads are a union TypeScript
      // will not accept a spread against, and this also keeps the copy correct
      // for a table of any width without a hand-written arm per arity.
      const placeholders = columns.map((name) => `@${name}`).join(", ");
      const insert = destination.prepare(`INSERT INTO main.${quoted} VALUES (${placeholders})`);

      for (const row of source.prepare(`SELECT * FROM ${quoted}`).iterate()) {
        const record = row as Record<string, unknown>;
        const bindings: Record<string, unknown> = {};
        for (const name of columns) {
          bindings[name] = record[name] ?? null;
        }
        insert.run(bindings);
      }
    }
  });

  copy();

  for (const index of indexes) {
    destination.exec(index.sql ?? "");
  }

  for (const object of late) {
    destination.exec(object.sql ?? "");
  }
}