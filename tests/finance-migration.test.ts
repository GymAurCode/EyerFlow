import { describe, expect, it } from "vitest";
import { openInMemoryDatabase } from "../src/data/connection";
import { runMigrations } from "../src/data/migrator";
import { migrations } from "../src/data/migrations";

/**
 * The upgrade path.
 *
 * A shop that has been trading for a year comes to the Finance module with
 * documents, payments and expenses that carry no journal entry. The
 * migration must leave every one of those records exactly as it was - the
 * accounting is added, not substituted - and the new columns must describe
 * the records honestly.
 */

describe("the finance migration", () => {
  it("adds the columns the Finance module needs without touching the records", () => {
    const db = openInMemoryDatabase();

    // Everything the shop had before the Finance module existed.
    const before = migrations.filter((migration) => migration.version < 22);
    runMigrations(db, before);

    db.prepare(
      `INSERT INTO parties (code, name, kind, opening_balance, is_active, created_at, updated_at)
       VALUES ('C-1', 'Old Customer', 'customer', 0, 1, '2024-01-01', '2024-01-01')`,
    ).run();
    db.prepare(
      `INSERT INTO products (sku, name, quantity_milli, average_cost_fils, sale_price_fils, is_active, created_at, updated_at)
       VALUES ('OLD-1', 'Old stock', 5_000, 2_000, 3_000, 1, '2024-01-01', '2024-01-01')`,
    ).run();
    db.prepare(
      `INSERT INTO documents (kind, number, party_id, issue_date, status, net_fils, vat_fils, gross_fils, paid_fils, cost_fils, created_at, updated_at)
       VALUES ('invoice', 'INV-2024-0001', 1, '2024-02-01', 'paid', 30_000, 0, 30_000, 30_000, 20_000, '2024-02-01', '2024-02-01')`,
    ).run();
    db.prepare(
      `INSERT INTO expenses (expense_date, category, description, amount_fils, vat_fils, payment_method, created_at, updated_at)
       VALUES ('2024-02-02', 'rent', 'Old rent', 15_000, 0, 'cash', '2024-02-02', '2024-02-02')`,
    ).run();

    // Now the Finance module arrives.
    runMigrations(db, migrations);

    const expense = db
      .prepare("SELECT amount_fils AS amount, paid_fils AS paid, account_code AS accountCode FROM expenses")
      .get() as { amount: number; paid: number; accountCode: string | null };

    // The old expense was paid in cash when it was recorded, so it is paid -
    // it must not appear as a liability the shop never owed.
    expect(expense.paid).toBe(expense.amount);
    // It has no account of its own, so it uses the category's default.
    expect(expense.accountCode).toBeNull();

    // And the document is exactly as it was.
    const document = db
      .prepare("SELECT number, gross_fils, paid_fils FROM documents")
      .get() as { number: string; gross_fils: number; paid_fils: number };
    expect(document.number).toBe("INV-2024-0001");
    expect(document.gross_fils).toBe(30_000);
    expect(document.paid_fils).toBe(30_000);
  });

  it("is idempotent: running it again changes nothing", () => {
    const db = openInMemoryDatabase();
    runMigrations(db, migrations);

    const before = db.prepare("SELECT COUNT(*) AS n FROM expenses").get() as { n: number };
    expect(before.n).toBe(0);

    // The migrator tracks what has run, so a second pass is a no-op.
    runMigrations(db, migrations);

    const after = db.prepare("SELECT COUNT(*) AS n FROM expenses").get() as { n: number };
    expect(after.n).toBe(before.n);
  });
});
