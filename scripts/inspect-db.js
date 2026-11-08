"use strict";

/**
 * Inspect an EyerStock database from the command line.
 *
 * Used for manual QA and for verifying a restore on a shop machine where the
 * GUI is not available.
 *
 * Usage: node scripts/inspect-db.js <path-to-db>
 */

const path = require("node:path");

const Database = require("better-sqlite3");

const dbPath = process.argv[2];

if (dbPath === undefined) {
  console.error("Usage: node scripts/inspect-db.js <path-to-db>");
  process.exit(1);
}

const db = new Database(path.resolve(dbPath), { readonly: true, fileMustExist: true });

try {
  const integrity = db.pragma("integrity_check");
  console.log("Integrity:", integrity[0].integrity_check);

  const migrations = db
    .prepare(
      "SELECT version, name, applied_at FROM schema_migrations WHERE applied_at IS NOT NULL ORDER BY version",
    )
    .all();

  console.log(
    `\nSchema version: ${migrations.length > 0 ? migrations[migrations.length - 1].version : 0}`,
  );
  console.log("Migrations:");
  for (const row of migrations) {
    console.log(`  v${row.version}  ${row.name}  (${row.applied_at})`);
  }

  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all();

  console.log(`\nTables (${tables.length}):`);
  for (const table of tables) {
    const count = db.prepare(`SELECT COUNT(*) AS n FROM ${table.name}`).get();
    console.log(`  ${table.name.padEnd(24)} ${count.n} rows`);
  }

  // Indices matter for performance; list them so a QA pass can confirm the
  // expected ones exist on a real database.
  const indices = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name",
    )
    .all();
  console.log(`\nIndexes (${indices.length}): ${indices.map((row) => row.name).join(", ")}`);
} finally {
  db.close();
}
