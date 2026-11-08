/**
 * Performance and query-plan harness.
 *
 * Two jobs, both easy to regress silently:
 *
 *  1. Prove the indexes are actually used. `EXPLAIN QUERY PLAN` is run against
 *     the queries the dashboard and catalogue issue and asserted to use an
 *     index. A dropped index does not throw - SQLite quietly falls back to a
 *     full scan - so nothing else in the suite would notice until a shop with
 *     a large catalogue noticed.
 *
 *  2. Prove the queries are still fast with a realistically large database.
 *     50,000 products and 20,000 documents is a busy shop's worth of history
 *     and is well past the point where a missing index becomes unusable.
 *
 * Budgets are deliberately loose. They exist to catch an order-of-magnitude
 * regression (a scan where an index was expected), not to police a few
 * milliseconds of machine noise.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDatabase, openInMemoryDatabase, type SqliteDatabase } from "../src/data/connection";
import { migrations } from "../src/data/migrations";
import { runMigrations } from "../src/data/migrator";
import { listProducts } from "../src/main/repositories/products";
import { dashboardSummary } from "../src/main/repositories/reports";

const PRODUCT_COUNT = 50_000;
const PARTY_COUNT = 2_000;
const DOCUMENT_COUNT = 20_000;

let db: SqliteDatabase;

/** Wall-clock budget for a single indexed query over the seeded data set. */
const BUDGET_MS = 750;

function seed(): void {
  const now = new Date("2026-06-15T09:00:00.000Z");

  const insertParty = db.prepare(
    `INSERT INTO parties (code, name, kind, opening_balance, created_at, updated_at)
     VALUES (?, ?, 'customer', 0, ?, ?)`,
  );
  const insertProduct = db.prepare(
    `INSERT INTO products (sku, barcode, name, category, quantity_milli, reorder_level_milli,
                           average_cost_fils, sale_price_fils, warranty_months, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 12, ?, ?)`,
  );
  const insertDocument = db.prepare(
    `INSERT INTO documents (kind, number, party_id, issue_date, status, net_fils, vat_fils,
                            gross_fils, cost_fils, fiscal_year, created_at, updated_at)
     VALUES ('invoice', ?, ?, ?, 'issued', ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertMovement = db.prepare(
    `INSERT INTO stock_movements (product_id, document_id, kind, quantity_milli,
                                  unit_cost_fils, cost_fils, movement_date, fiscal_year)
     VALUES (?, 1, 'issue', ?, ?, ?, ?, ?)`,
  );

  const categories = ["Purifiers", "Filters", "Fittings", "Spares", "Service"] as const;

  db.transaction(() => {
    for (let i = 1; i <= PARTY_COUNT; i += 1) {
      insertParty.run(`C-${String(i).padStart(6, "0")}`, `Customer ${String(i)}`, now.toISOString(), now.toISOString());
    }

    for (let i = 1; i <= PRODUCT_COUNT; i += 1) {
      const category = categories[i % categories.length] ?? "Spares";
      insertProduct.run(
        `SKU-${String(i).padStart(6, "0")}`,
        `8901234${String(i).padStart(6, "0")}`,
        `${category} item ${String(i)}`,
        category,
        (i % 500) * 1000,
        50_000,
        10_000 + (i % 900),
        25_000 + (i % 1500),
        now.toISOString(),
        now.toISOString(),
      );
    }

    for (let i = 1; i <= DOCUMENT_COUNT; i += 1) {
      const month = String((i % 12) + 1).padStart(2, "0");
      const day = String((i % 28) + 1).padStart(2, "0");
      const net = 100_000 + (i % 90_000);
      const vat = Math.round(net * 0.05);
      insertDocument.run(
        `INV-${String(i).padStart(7, "0")}`,
        ((i % PARTY_COUNT) + 1),
        `2025-${month}-${day}`,
        net,
        vat,
        net + vat,
        Math.round(net * 0.6),
        2025,
        now.toISOString(),
        now.toISOString(),
      );
    }

    for (let i = 1; i <= PRODUCT_COUNT; i += 1) {
      insertMovement.run(
        i,
        1_000,
        10_000,
        10_000,
        `2025-${String((i % 12) + 1).padStart(2, "0")}-15`,
        2025,
      );
    }
  })();
}

/** Query-plan detail rows for a statement. */
function explain(sql: string, ...params: (string | number)[]): string[] {
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[];
  return rows.map((row) => row.detail);
}

function timed<T>(run: () => T): { readonly ms: number; readonly value: T } {
  const started = performance.now();
  const value = run();
  return { ms: performance.now() - started, value };
}

beforeAll(() => {
  db = openInMemoryDatabase();
  runMigrations(db, migrations);
  seed();
});

afterAll(() => {
  closeDatabase(db);
});

describe("query plans use indexes rather than scanning", () => {
  it("resolves a catalogue search by name", () => {
    const plan = explain("SELECT * FROM products WHERE name LIKE ? ORDER BY name LIMIT 50", "%item 4%");
    expect(plan.some((detail) => detail.includes("USING INDEX"))).toBe(true);
  });

  it("filters documents by kind, status and issue date", () => {
    const plan = explain(
      `SELECT COALESCE(SUM(gross_fils), 0) FROM documents
        WHERE kind = 'invoice' AND status <> 'cancelled' AND issue_date BETWEEN ? AND ?`,
      "2025-01-01",
      "2025-12-31",
    );
    expect(plan.some((detail) => detail.includes("USING INDEX"))).toBe(true);
  });

  it("looks up a product by its unique SKU", () => {
    const plan = explain("SELECT * FROM products WHERE sku = ?", "SKU-000001");
    expect(plan.some((detail) => detail.includes("USING INDEX"))).toBe(true);
  });
});

describe("the app stays responsive on a large database", () => {
  it("seeds a realistically sized catalogue", () => {
    const products = db.prepare("SELECT COUNT(*) AS n FROM products").get() as { n: number };
    const documents = db.prepare("SELECT COUNT(*) AS n FROM documents").get() as { n: number };
    expect(products.n).toBe(PRODUCT_COUNT);
    expect(documents.n).toBe(DOCUMENT_COUNT);
  });

  it("lists the catalogue quickly", () => {
    const { ms, value } = timed(() => listProducts(db, { limit: 500 }));
    expect(value).toHaveLength(500);
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it("searches the catalogue quickly", () => {
    const { ms, value } = timed(() => listProducts(db, { search: "Purifiers item 1", limit: 200 }));
    expect(ms).toBeLessThan(BUDGET_MS);
    expect(value.length).toBeGreaterThan(0);
  });

  it("builds the dashboard quickly", () => {
    const { ms } = timed(() =>
      dashboardSummary(db, { fromDate: "2025-01-01", toDate: "2025-12-31" }, new Date()),
    );
    expect(ms).toBeLessThan(BUDGET_MS);
  });
});
