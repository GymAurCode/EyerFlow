/**
 * Audit-writer guards against the schema it actually has.
 *
 * Migration 018 ("simplify to core inventory") dropped `audit_log` along with
 * the audit viewer. The writer was not part of that removal, so every mutating
 * repository still called `recordAudit` and the write threw
 * `no such table: audit_log` from inside the caller's transaction.
 *
 * The worst of it was invisible for a long time because it broke the one flow
 * every new customer runs first: `auth.setup` died inside `runSetup`, the
 * wizard reported "Something went wrong", and there was no way past it. The
 * end-to-end suite could not catch it either, because the activation screen sat
 * in front of the setup wizard.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { openInMemoryDatabase } from "../src/data/connection";
import { runMigrations } from "../src/data/migrator";
import { migrations } from "../src/data/migrations";
import type { SqliteDatabase } from "../src/data/connection";
import { SYSTEM_ACTOR, hasAuditLedger, recordAudit } from "../src/main/audit-writer";
import { runSetup } from "../src/main/repositories/users";

function migratedDatabase(): SqliteDatabase {
  const db = openInMemoryDatabase();
  runMigrations(db, migrations);
  return db;
}

describe("the audit ledger", () => {
  let db: SqliteDatabase;

  beforeEach(() => {
    db = migratedDatabase();
  });

  it("exists after the latest migration (MMS needs it)", () => {
    // Migration 018 dropped audit_log, but migration 025 (manufacturing) recreates
    // it because the production dashboard and every MMS repository depend on it.
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'audit_log'")
      .get() as { name?: unknown } | undefined;

    expect(row).toBeDefined();
    expect(hasAuditLedger(db)).toBe(true);
  });

  it("makes recordAudit a no-op instead of throwing", () => {
    expect(() => {
      recordAudit(
        db,
        SYSTEM_ACTOR,
        { module: "settings", action: "test", entityType: "app", entityId: null },
        new Date().toISOString(),
      );
    }).not.toThrow();
  });

  it("lets first-run setup complete on a fresh database", () => {
    // The regression itself: this threw "no such table: audit_log", so a new
    // installation could not be set up at all.
    expect(() => {
      runSetup(
        { db, actor: SYSTEM_ACTOR, nowIso: new Date().toISOString() },
        {
          companyName: "Blue Water Trading",
          companyTrn: "",
          companyAddress: "",
          companyPhone: "",
          fiscalYearStartMonth: 1,
          adminUsername: "admin",
          adminDisplayName: "Test Administrator",
          adminPassword: "Water#2026",
        },
      );
    }).not.toThrow();

    const user = db.prepare("SELECT username FROM users WHERE username = ?").get("admin") as
      { username?: unknown } | undefined;
    expect(user?.username).toBe("admin");

    const company = db.prepare("SELECT value FROM settings WHERE key = ?").get("company_name") as
      { value?: unknown } | undefined;
    expect(company?.value).toBe("Blue Water Trading");
  });

  it("does not swallow a real failure while writing to a ledger that exists", () => {
    // A database that has not been migrated past 018 still carries the table,
    // created back in migration 009, and must go on writing entries to it.
    const withLedger = openInMemoryDatabase();
    runMigrations(
      withLedger,
      migrations.filter((m) => m.version < 18),
    );

    expect(hasAuditLedger(withLedger)).toBe(true);
    recordAudit(
      withLedger,
      SYSTEM_ACTOR,
      { module: "settings", action: "test", entityType: "app", entityId: null },
      new Date().toISOString(),
    );

    const rows = withLedger.prepare("SELECT entry_hash FROM audit_log").all() as {
      entry_hash: string;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.entry_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
