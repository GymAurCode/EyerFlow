import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkIntegrity,
  closeDatabase,
  openInMemoryDatabase,
  openDatabase,
} from "../src/data/connection";
import {
  MigrationError,
  findModifiedMigrations,
  getAppliedMigrations,
  getCurrentSchemaVersion,
  planMigrations,
  runMigrations,
  type Migration,
} from "../src/data/migrator";
import { migrations } from "../src/data/migrations";
import {
  buildBackupFilename,
  createBackup,
  pruneBackups,
  restoreBackup,
  verifyBackupFile,
} from "../src/data/backup";
import {
  backdateFile,
  createTempWorkspace,
  seedLegacyV1Database,
  writeGarbageFile,
  type TempWorkspace,
} from "./helpers";

/**
 * Highest shipped migration version, derived rather than hard-coded so adding a
 * migration does not require editing assertions across this file.
 */
const LATEST_SCHEMA_VERSION = Math.max(...migrations.map((migration) => migration.version));

let workspace: TempWorkspace;

beforeEach(() => {
  workspace = createTempWorkspace();
});

afterEach(() => {
  workspace.cleanup();
});

function migration(version: number, name: string, sql: string): Migration {
  return {
    version,
    name,
    up: (db) => {
      db.exec(sql);
    },
  };
}

describe("migration runner", () => {
  it("applies migrations in version order", () => {
    const db = openInMemoryDatabase();
    const result = runMigrations(db, [
      migration(2, "second", "CREATE TABLE b (id INTEGER)"),
      migration(1, "first", "CREATE TABLE a (id INTEGER)"),
    ]);

    expect(result.applied.map((m) => m.version)).toEqual([1, 2]);
    expect(result.fromVersion).toBe(0);
    expect(result.toVersion).toBe(2);
    closeDatabase(db);
  });

  it("records each migration with a timestamp", () => {
    const db = openInMemoryDatabase();
    runMigrations(db, [migration(1, "first", "CREATE TABLE a (id INTEGER)")]);

    const applied = getAppliedMigrations(db);
    expect(applied).toHaveLength(1);
    expect(applied[0]?.name).toBe("first");
    expect(Number.isNaN(Date.parse(applied[0]?.appliedAt ?? ""))).toBe(false);
    closeDatabase(db);
  });

  it("is a no-op when everything is already applied", () => {
    const db = openInMemoryDatabase();
    const list = [migration(1, "first", "CREATE TABLE a (id INTEGER)")];

    runMigrations(db, list);
    const second = runMigrations(db, list);

    expect(second.applied).toHaveLength(0);
    expect(second.fromVersion).toBe(1);
    closeDatabase(db);
  });

  it("rolls back a failing migration and leaves the version intact", () => {
    const db = openInMemoryDatabase();
    const list: Migration[] = [
      migration(1, "ok", "CREATE TABLE a (id INTEGER)"),
      {
        version: 2,
        name: "broken",
        up: (target) => {
          // Half-apply, then fail: a non-transactional runner would leave the
          // table behind with a half-updated schema version.
          target.exec("CREATE TABLE half_created (id INTEGER)");
          throw new Error("deliberate failure");
        },
      },
    ];

    expect(() => runMigrations(db, list)).toThrow(MigrationError);
    expect(getCurrentSchemaVersion(db)).toBe(1);

    const halfCreated = db
      .prepare("SELECT name FROM sqlite_master WHERE name='half_created'")
      .get();
    expect(halfCreated).toBeUndefined();
    closeDatabase(db);
  });

  it("reports the failing version on the error", () => {
    const db = openInMemoryDatabase();
    try {
      runMigrations(db, [
        {
          version: 7,
          name: "explodes",
          up: () => {
            throw new Error("nope");
          },
        },
      ]);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(MigrationError);
      expect((error as MigrationError).version).toBe(7);
      expect((error as Error).message).toMatch(/rolled back/);
    } finally {
      closeDatabase(db);
    }
  });

  it("invokes the pre-migration hook exactly once", () => {
    const db = openInMemoryDatabase();
    const hook = vi.fn();

    runMigrations(
      db,
      [
        migration(1, "a", "CREATE TABLE a (id INTEGER)"),
        migration(2, "b", "CREATE TABLE b (id INTEGER)"),
      ],
      hook,
    );

    expect(hook).toHaveBeenCalledTimes(1);
    closeDatabase(db);
  });

  it("does not invoke the hook when nothing is pending", () => {
    const db = openInMemoryDatabase();
    const list = [migration(1, "a", "CREATE TABLE a (id INTEGER)")];
    runMigrations(db, list);

    const hook = vi.fn();
    runMigrations(db, list, hook);
    expect(hook).not.toHaveBeenCalled();
    closeDatabase(db);
  });

  it("rejects duplicate version numbers", () => {
    const db = openInMemoryDatabase();
    expect(() =>
      planMigrations(db, [
        migration(1, "a", "CREATE TABLE a (id INTEGER)"),
        migration(1, "b", "CREATE TABLE b (id INTEGER)"),
      ]),
    ).toThrow(/Duplicate migration version 1/);
    closeDatabase(db);
  });

  it("rejects non-positive version numbers", () => {
    const db = openInMemoryDatabase();
    expect(() => planMigrations(db, [migration(0, "a", "SELECT 1")])).toThrow(/positive integer/);
    closeDatabase(db);
  });

  it("refuses to open a database from a newer build", () => {
    // Simulates a user running an older installer over a newer database.
    const db = openInMemoryDatabase();
    runMigrations(db, [migration(5, "future", "CREATE TABLE future (id INTEGER)")]);

    expect(() => planMigrations(db, [migration(1, "old", "SELECT 1")])).toThrow(
      /newer than this build supports/,
    );
    closeDatabase(db);
  });

  it("flags an already-applied migration whose name was edited", () => {
    const db = openInMemoryDatabase();
    runMigrations(db, [migration(1, "original_name", "CREATE TABLE a (id INTEGER)")]);

    const modified = findModifiedMigrations(db, [
      migration(1, "edited_name", "CREATE TABLE a (id INTEGER)"),
    ]);
    expect(modified).toHaveLength(1);
    closeDatabase(db);
  });

  it("plans only the outstanding migrations", () => {
    const db = openInMemoryDatabase();
    runMigrations(db, [migration(1, "a", "CREATE TABLE a (id INTEGER)")]);

    const plan = planMigrations(db, [
      migration(1, "a", "CREATE TABLE a (id INTEGER)"),
      migration(2, "b", "CREATE TABLE b (id INTEGER)"),
    ]);

    expect(plan.currentVersion).toBe(1);
    expect(plan.pending.map((m) => m.version)).toEqual([2]);
    closeDatabase(db);
  });
});

describe("production schema", () => {
  it("applies the full migration list cleanly", () => {
    const db = openInMemoryDatabase();
    const result = runMigrations(db, migrations);

    expect(result.toVersion).toBe(LATEST_SCHEMA_VERSION);
    expect(getCurrentSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    closeDatabase(db);
  });

  it("creates every table the brief depends on", () => {
    const db = openInMemoryDatabase();
    runMigrations(db, migrations);

    // Only the tables the kept features depend on. Migration 18 dropped
    // quotations, returns, cheques, kits, barcode labels, service, warranty,
    // period lock, onboarding and licences. Migration 025 (manufacturing)
    // recreates audit_log because MMS depends on it, so audit_log is present
    // but not in this kept-features list.
    const expected = [
      "parties",
      "products",
      "documents",
      "document_lines",
      "stock_movements",
      "payments",
      "payment_allocations",
      "expenses",
      "users",
      "roles",
      "role_permissions",
      "login_attempts",
      "partners",
      "partner_transactions",
      "settings",
      "document_sequences",
    ];

    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
      name: string;
    }[];
    const present = new Set(rows.map((row) => row.name));

    for (const table of expected) {
      expect(present.has(table), `missing table ${table}`).toBe(true);
    }
    closeDatabase(db);
  });

  it("drops the tables of the removed features", () => {
    const db = openInMemoryDatabase();
    runMigrations(db, migrations);

    const dropped = [
      "cheques",
      "serial_units",
      "warranty_claims",
      "service_contracts",
      "service_visits",
      "filter_schedules",
      "installations",
      "product_bundles",
      "bundle_components",
      "period_closures",
      "period_locks",
      "onboarding_steps",
      "supplier_bills",
      "licences",
      // audit_log is intentionally NOT here: migration 025 (manufacturing)
      // recreates it because the production dashboard and every MMS
      // repository depend on it.
    ];

    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
      name: string;
    }[];
    const present = new Set(rows.map((row) => row.name));

    for (const table of dropped) {
      expect(present.has(table), `table ${table} should have been dropped`).toBe(false);
    }
    closeDatabase(db);
  });

  it("collapses the roles to the two fixed ones", () => {
    const db = openInMemoryDatabase();
    runMigrations(db, migrations);

    const roles = (
      db.prepare("SELECT name FROM roles ORDER BY name").all() as { name: string }[]
    ).map((row) => row.name);
    expect(roles).toEqual(["Administrator", "Staff"]);
    closeDatabase(db);
  });

  it("enforces foreign keys", () => {
    const db = openInMemoryDatabase();
    runMigrations(db, migrations);

    // party_id 9999 does not exist; the insert must be refused rather than
    // silently leaving an invoice with a dangling party reference.
    expect(() =>
      db
        .prepare(
          `INSERT INTO documents (kind, number, party_id, issue_date, net_fils, vat_fils, gross_fils, created_at, updated_at)
           VALUES ('invoice', 'INV-FK-0001', 9999, '2026-01-01', 100, 5, 105, '2026-01-01', '2026-01-01')`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY/i);
    closeDatabase(db);
  });

  it("allows a document with no party (cash sale)", () => {
    const db = openInMemoryDatabase();
    runMigrations(db, migrations);

    expect(() =>
      db
        .prepare(
          `INSERT INTO documents (kind, number, party_id, issue_date, net_fils, vat_fils, gross_fils, created_at, updated_at)
           VALUES ('invoice', 'INV-CASH-0001', NULL, '2026-01-01', 100, 5, 105, '2026-01-01', '2026-01-01')`,
        )
        .run(),
    ).not.toThrow();
    closeDatabase(db);
  });

  it("rejects an invalid document kind", () => {
    const db = openInMemoryDatabase();
    runMigrations(db, migrations);

    expect(() =>
      db
        .prepare(
          `INSERT INTO documents (kind, number, issue_date, net_fils, vat_fils, gross_fils, created_at, updated_at)
           VALUES ('not-a-kind', 'X-1', '2026-01-01', 0, 0, 0, '2026-01-01', '2026-01-01')`,
        )
        .run(),
    ).toThrow(/CHECK constraint/i);
    closeDatabase(db);
  });

  it("passes an integrity check after migrating", () => {
    const db = openInMemoryDatabase();
    runMigrations(db, migrations);
    expect(checkIntegrity(db).ok).toBe(true);
    closeDatabase(db);
  });

  it("creates the indexes the performance work depends on", () => {
    const db = openInMemoryDatabase();
    runMigrations(db, migrations);

    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as {
      name: string;
    }[];
    const names = rows.map((row) => row.name);

    for (const index of ["idx_products_barcode", "idx_documents_party", "idx_movements_product"]) {
      expect(names, `missing index ${index}`).toContain(index);
    }
    closeDatabase(db);
  });
});

describe("migration safety on an existing database", () => {
  /**
   * The critical guarantee: an existing shop database is upgraded forward with
   * its data intact. A runner that recreates tables, or a migration that drops
   * them, fails here.
   */
  it("upgrades a legacy database and preserves all existing rows", () => {
    const dbPath = workspace.dbPath;
    const db = openDatabase(dbPath);

    seedLegacyV1Database(db);

    const partyCountBefore = (
      db.prepare("SELECT COUNT(*) AS n FROM parties").get() as { n: number }
    ).n;
    const productCountBefore = (
      db.prepare("SELECT COUNT(*) AS n FROM products").get() as { n: number }
    ).n;
    expect(partyCountBefore).toBe(2);
    expect(productCountBefore).toBe(3);

    const result = runMigrations(db, migrations);

    // version 1 was already recorded, so only 2..latest should run.
    const pending = migrations
      .map((m) => m.version)
      .filter((version) => version > 1)
      .sort((a, b) => a - b);

    expect(result.fromVersion).toBe(1);
    expect(result.toVersion).toBe(LATEST_SCHEMA_VERSION);
    expect(result.applied.map((m) => m.version)).toEqual(pending);

    // Pre-existing rows survive.
    expect((db.prepare("SELECT COUNT(*) AS n FROM parties").get() as { n: number }).n).toBe(2);
    expect((db.prepare("SELECT COUNT(*) AS n FROM products").get() as { n: number }).n).toBe(3);

    // And the legacy values are still readable and correct.
    const party = db
      .prepare("SELECT name, opening_balance FROM parties WHERE code = 'C-0001'")
      .get() as {
      name: string;
      opening_balance: number;
    };
    expect(party.name).toBe("Al Rawi Trading");
    expect(party.opening_balance).toBe(25_000);

    const product = db
      .prepare(
        "SELECT name, quantity_milli, average_cost_fils FROM products WHERE sku = 'RO-5STAGE'",
      )
      .get() as { name: string; quantity_milli: number; average_cost_fils: number };
    expect(product.name).toBe("5-Stage RO System");
    expect(product.quantity_milli).toBe(10_000);
    expect(product.average_cost_fils).toBe(45_000);

    // Columns present since v1 are readable with their recorded values.
    const enriched = db
      .prepare(
        "SELECT vat_treatment, is_serialised, warranty_months FROM products WHERE sku = 'FIL-CARBON'",
      )
      .get() as {
      vat_treatment: string;
      is_serialised: number;
      warranty_months: number;
    };
    expect(enriched.vat_treatment).toBe("standard");
    expect(enriched.is_serialised).toBe(0);
    expect(enriched.warranty_months).toBe(12);

    closeDatabase(db);
  });

  it("leaves the upgraded database passing an integrity check", () => {
    const db = openDatabase(workspace.dbPath);
    seedLegacyV1Database(db);
    runMigrations(db, migrations);
    expect(checkIntegrity(db).ok).toBe(true);
    closeDatabase(db);
  });

  it("is idempotent across repeated startup", () => {
    const db = openDatabase(workspace.dbPath);
    runMigrations(db, migrations);
    const first = getCurrentSchemaVersion(db);

    for (let run = 0; run < 3; run += 1) {
      runMigrations(db, migrations);
    }

    expect(getCurrentSchemaVersion(db)).toBe(first);
    expect(getAppliedMigrations(db)).toHaveLength(migrations.length);
    closeDatabase(db);
  });

  it("preserves rows added after the upgrade when migrating again later", () => {
    const db = openDatabase(workspace.dbPath);
    runMigrations(db, migrations);

    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO parties (code, name, kind, opening_balance, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("C-9999", "Post-upgrade Customer", "customer", 5000, now, now);

    db.prepare(
      `INSERT INTO parties (code, name, kind, opening_balance, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("C-9999-2", "Second Post-upgrade", "customer", 0, now, now);

    runMigrations(db, migrations);
    expect((db.prepare("SELECT COUNT(*) AS n FROM parties").get() as { n: number }).n).toBe(2);
    closeDatabase(db);
  });

  it("rejects duplicate invoice numbers per kind", () => {
    const db = openDatabase(workspace.dbPath);
    runMigrations(db, migrations);

    const now = new Date().toISOString();
    const insert = db.prepare(
      `INSERT INTO documents (kind, number, issue_date, net_fils, vat_fils, gross_fils, created_at, updated_at)
       VALUES ('invoice', ?, '2026-01-01', 100, 5, 105, ?, ?)`,
    );
    insert.run("INV-0001", now, now);
    expect(() => insert.run("INV-0001", now, now)).toThrow(/UNIQUE/i);
    closeDatabase(db);
  });
});

describe("migration 017: widening the VAT treatment constraint", () => {
  /**
   * Migration 17 rebuilds `products` and `product_bundles` to widen their CHECK
   * constraint. A rebuild is the riskiest shape of migration there is, so it is
   * pinned down explicitly: the data must survive with identical values and ids,
   * the new treatment must be accepted, the old treatments must still be
   * rejected, and the indexes and foreign keys must come back.
   */
  const upToV16 = migrations.filter((migration) => migration.version < 17);

  it("preserves every product row, column and id across the rebuild", () => {
    const db = openDatabase(workspace.dbPath);
    runMigrations(db, upToV16);

    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO products (sku, name, quantity_milli, average_cost_fils, sale_price_fils,
                             vat_treatment, is_serialised, warranty_months, created_at, updated_at)
       VALUES ('RO-5STAGE', '5-Stage RO System', 10000, 45000, 120000,
               'zero', 1, 24, ?, ?)`,
    ).run(now, now);

    const before = db.prepare("SELECT * FROM products ORDER BY id").all() as Record<
      string,
      unknown
    >[];

    runMigrations(db, migrations);

    const after = db.prepare("SELECT * FROM products ORDER BY id").all() as Record<
      string,
      unknown
    >[];

    // Migration 24 is additive and adds new columns to products. Compare only the
    // columns that existed before migration 17, so the additive changes do not
    // invalidate the rebuild test.
    const commonKeys = Object.keys(before[0] ?? {}).filter((key) =>
      Object.prototype.hasOwnProperty.call(after[0] ?? {}, key),
    );
    expect(after.map((row) => Object.fromEntries(commonKeys.map((key) => [key, row[key]])))).toEqual(
      before.map((row) => Object.fromEntries(commonKeys.map((key) => [key, row[key]]))),
    );
    closeDatabase(db);
  });

  it("accepts the new outside-scope treatment", () => {
    const db = openDatabase(workspace.dbPath);
    runMigrations(db, migrations);

    const now = new Date().toISOString();
    expect(() =>
      db
        .prepare(
          `INSERT INTO products (sku, name, vat_treatment, created_at, updated_at)
           VALUES ('OS-1', 'Out of scope supply', 'outsideScope', ?, ?)`,
        )
        .run(now, now),
    ).not.toThrow();

    expect(
      db.prepare("SELECT vat_treatment FROM products WHERE sku = 'OS-1'").get() as {
        vat_treatment: string;
      },
    ).toEqual({ vat_treatment: "outsideScope" });
    closeDatabase(db);
  });

  it("still rejects a treatment that is not in the VAT register", () => {
    const db = openDatabase(workspace.dbPath);
    runMigrations(db, migrations);

    const now = new Date().toISOString();
    expect(() =>
      db
        .prepare(
          `INSERT INTO products (sku, name, vat_treatment, created_at, updated_at)
           VALUES ('BAD-1', 'Nonsense treatment', 'invented', ?, ?)`,
        )
        .run(now, now),
    ).toThrow(/CHECK constraint failed/i);
    closeDatabase(db);
  });

  it("restores the product indexes after the rebuild", () => {
    const db = openDatabase(workspace.dbPath);
    runMigrations(db, migrations);

    const indexes = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'products'")
        .all() as {
        name: string;
      }[]
    ).map((row) => row.name);

    expect(indexes).toContain("idx_products_barcode");
    expect(indexes).toContain("idx_products_name");
    expect(indexes).toContain("idx_products_category");
    expect(indexes).toContain("idx_products_barcode_unique");
    closeDatabase(db);
  });

  it("leaves no referential integrity violation behind", () => {
    const db = openDatabase(workspace.dbPath);
    runMigrations(db, upToV16);

    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO parties (code, name, kind, opening_balance, created_at, updated_at)
       VALUES ('C-0001', 'Reference Customer', 'customer', 0, ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO products (sku, name, created_at, updated_at)
       VALUES ('RO-5STAGE', '5-Stage RO System', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO documents (kind, number, issue_date, net_fils, vat_fils, gross_fils, created_at, updated_at)
       VALUES ('invoice', 'INV-0001', '2026-01-01', 500, 25, 525, ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO document_lines (document_id, line_no, description, quantity_milli,
                                   unit_price_fils, net_fils, vat_fils, vat_treatment,
                                   unit_cost_fils, cost_fils)
       VALUES (1, 1, 'Legacy line', 1000, 500, 500, 25, 'standard', 300, 300)`,
    );

    runMigrations(db, migrations);

    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(checkIntegrity(db).ok).toBe(true);
    closeDatabase(db);
  });

  it("re-enables foreign key enforcement once the rebuild finishes", () => {
    const db = openDatabase(workspace.dbPath);
    runMigrations(db, migrations);

    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    closeDatabase(db);
  });
});

describe("backup and restore", () => {
  function seedMigratedDatabase(): { db: ReturnType<typeof openDatabase>; dbPath: string } {
    const dbPath = workspace.dbPath;
    const db = openDatabase(dbPath);
    runMigrations(db, migrations);

    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO parties (code, name, kind, opening_balance, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("C-0001", "Al Rawi Trading", "customer", 10_000, now, now);
    return { db, dbPath };
  }

  it("creates a non-empty backup file", async () => {
    const { db, dbPath } = seedMigratedDatabase();
    const destination = join(workspace.dir, "backups", "snapshot.db");

    const result = await createBackup(db, destination);

    expect(existsSync(destination)).toBe(true);
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(statSync(destination).size).toBe(result.sizeBytes);
    closeDatabase(db);
    expect(dbPath).toBeTruthy();
  });

  it("includes committed data in the backup", async () => {
    const { db } = seedMigratedDatabase();
    const destination = join(workspace.dir, "backups", "with-data.db");
    await createBackup(db, destination);

    const verification = verifyBackupFile(destination);
    expect(verification.ok).toBe(true);
    expect(verification.schemaVersion).toBe(LATEST_SCHEMA_VERSION);

    // Reopen the backup independently and confirm the row is there.
    const backupDb = openDatabase(destination);
    const row = backupDb.prepare("SELECT name FROM parties WHERE code='C-0001'").get() as {
      name: string;
    };
    expect(row.name).toBe("Al Rawi Trading");
    backupDb.close();
    closeDatabase(db);
  });

  it("reports a missing backup file clearly", () => {
    const verification = verifyBackupFile(join(workspace.dir, "does-not-exist.db"));
    expect(verification.ok).toBe(false);
    expect(verification.message).toMatch(/not found/i);
  });

  it("rejects a file that is not a database", () => {
    const junkPath = join(workspace.dir, "junk.db");
    writeGarbageFile(junkPath);

    const verification = verifyBackupFile(junkPath);
    expect(verification.ok).toBe(false);
    expect(verification.message).toMatch(/not a readable sqlite database|not an eyerstock/i);
  });

  it("rejects a valid SQLite file that is not one of our backups", async () => {
    const { db } = seedMigratedDatabase();
    const foreignPath = join(workspace.dir, "foreign.db");
    await createBackup(db, foreignPath);

    const foreign = openDatabase(foreignPath);
    foreign.exec("DROP TABLE schema_migrations");
    foreign.close();

    const verification = verifyBackupFile(foreignPath);
    expect(verification.ok).toBe(false);
    expect(verification.message).toMatch(/not an eyerstock backup/i);
    closeDatabase(db);
  });

  it("restores a backup over the live database", async () => {
    const { db, dbPath } = seedMigratedDatabase();
    const destination = join(workspace.dir, "backups", "restore-source.db");
    await createBackup(db, destination);
    closeDatabase(db);

    // Corrupt/lose the live data, then restore.
    const live = openDatabase(dbPath);
    live.prepare("DELETE FROM parties").run();
    expect((live.prepare("SELECT COUNT(*) AS n FROM parties").get() as { n: number }).n).toBe(0);
    closeDatabase(live);

    const outcome = restoreBackup(dbPath, destination, {
      expectedSchemaVersion: LATEST_SCHEMA_VERSION,
    });
    expect(outcome.restored.path).toBe(dbPath);

    const reopened = openDatabase(dbPath);
    expect((reopened.prepare("SELECT COUNT(*) AS n FROM parties").get() as { n: number }).n).toBe(
      1,
    );
    closeDatabase(reopened);
  });

  it("cannot replace the database file while a connection to it is open", async () => {
    // The reason the restore IPC handler closes the database before calling
    // restoreBackup. Windows refuses to rename over a file that this process
    // has open, so an open connection makes every restore fail - silently, in
    // the sense that the app reports "the restore failed" and carries on with
    // the data it already had.
    const { db, dbPath } = seedMigratedDatabase();
    const destination = join(workspace.dir, "backups", "restore-source.db");
    await createBackup(db, destination);

    if (process.platform !== "win32") {
      closeDatabase(db);
      return;
    }

    expect(() =>
      restoreBackup(dbPath, destination, { expectedSchemaVersion: LATEST_SCHEMA_VERSION }),
    ).toThrow();

    // Closed, the same call succeeds - which is what the handler relies on.
    closeDatabase(db);
    expect(() =>
      restoreBackup(dbPath, destination, { expectedSchemaVersion: LATEST_SCHEMA_VERSION }),
    ).not.toThrow();
  });

  it("takes a safety copy of current data before restoring", async () => {
    const { db, dbPath } = seedMigratedDatabase();
    const destination = join(workspace.dir, "backups", "restore-source.db");
    await createBackup(db, destination);

    const safetyPath = join(workspace.dir, "backups", "safety.db");
    closeDatabase(db);

    const outcome = restoreBackup(dbPath, destination, {
      expectedSchemaVersion: LATEST_SCHEMA_VERSION,
      safetyBackupPath: safetyPath,
    });

    expect(outcome.safetyBackupPath).toBe(safetyPath);
    expect(existsSync(safetyPath)).toBe(true);
    expect(statSync(safetyPath).size).toBeGreaterThan(0);
  });

  it("refuses to restore a backup from a newer schema version", async () => {
    const { db, dbPath } = seedMigratedDatabase();
    const destination = join(workspace.dir, "backups", "future.db");
    await createBackup(db, destination);
    closeDatabase(db);

    expect(() => restoreBackup(dbPath, destination, { expectedSchemaVersion: 1 })).toThrow(
      /newer version of the app/i,
    );
  });

  it("refuses to restore a corrupt backup", () => {
    const { db, dbPath } = seedMigratedDatabase();
    closeDatabase(db);

    const corrupt = join(workspace.dir, "corrupt.db");
    writeGarbageFile(corrupt);

    expect(() =>
      restoreBackup(dbPath, corrupt, { expectedSchemaVersion: LATEST_SCHEMA_VERSION }),
    ).toThrow(/corrupt|readable/i);
  });

  it("names backups with a sortable timestamp", () => {
    const when = new Date(2026, 3, 9, 14, 5, 6);
    expect(buildBackupFilename("eyerstock", when)).toBe("eyerstock-20260409-140506.db");
  });

  it("prunes to the newest N backups", async () => {
    const { db } = seedMigratedDatabase();
    const backupDir = join(workspace.dir, "many-backups");

    // Distinct mtimes so ordering is deterministic.
    const base = Date.now() - 10_000_000;
    for (let index = 0; index < 5; index += 1) {
      const path = join(backupDir, `backup-${index}.db`);
      await createBackup(db, path);
      backdateFile(path, base + index * 1000);
    }
    closeDatabase(db);

    const removed = pruneBackups(backupDir, 2);

    expect(removed).toHaveLength(3);
    expect(removed).toContain("backup-0.db");
    expect(removed).toContain("backup-1.db");
    expect(removed).toContain("backup-2.db");
    expect(existsSync(join(backupDir, "backup-4.db"))).toBe(true);
    expect(existsSync(join(backupDir, "backup-0.db"))).toBe(false);
  });

  it("validates the retention count", () => {
    expect(() => pruneBackups(workspace.dir, 0)).toThrow(RangeError);
  });
});
