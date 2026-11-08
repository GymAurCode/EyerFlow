import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, openInMemoryDatabase, type SqliteDatabase } from "../src/data/connection";
import { listProducts } from "../src/main/repositories/products";
import { migrateInMemory } from "./helpers";

/**
 * Product list reads.
 *
 * The cost history is now filtered to the products the caller is about to
 * return. That is a performance change with a correctness risk: a mistake in
 * the IN-list would silently show zero for the last cost and last sale price.
 */

let db: SqliteDatabase;

const NOW = "2026-03-01T00:00:00.000Z";

function insertProduct(sku: string): number {
  const info = db
    .prepare(
      `INSERT INTO products (sku, name, quantity_milli, average_cost_fils, sale_price_fils,
                             created_at, updated_at)
       VALUES (?, ?, 0, 0, 0, ?, ?)`,
    )
    .run(sku, sku, NOW, NOW);
  return Number(info.lastInsertRowid);
}

function insertDocument(id: number, kind: "invoice" | "purchaseInvoice", issueDate: string): void {
  db.prepare(
    `INSERT INTO documents
       (id, kind, number, issue_date, status, net_fils, vat_fils, gross_fils, cost_fils,
        fiscal_year, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'issued', 0, 0, 0, 0, 2026, ?, ?)`,
  ).run(id, kind, `${kind}-${String(id)}`, issueDate, NOW, NOW);
}

function insertLine(documentId: number, productId: number, unitPriceFils: number): void {
  db.prepare(
    `INSERT INTO document_lines
       (document_id, line_no, product_id, description, quantity_milli, unit_price_fils,
        net_fils, vat_fils, vat_treatment, unit_cost_fils, cost_fils)
     VALUES (?, 1, ?, 'line', 1000, ?, 0, 0, 'standard', 0, 0)`,
  ).run(documentId, productId, unitPriceFils);
}

beforeEach(() => {
  db = openInMemoryDatabase();
  migrateInMemory(db);
});

afterEach(() => {
  closeDatabase(db);
});

describe("listProducts", () => {
  it("returns the last purchase cost and last sale price for the returned rows", () => {
    const first = insertProduct("A");
    const second = insertProduct("B");

    insertDocument(1, "purchaseInvoice", "2026-01-01");
    insertLine(1, first, 500);
    insertLine(1, second, 700);

    insertDocument(2, "invoice", "2026-01-02");
    insertLine(2, first, 900);

    const rows = listProducts(db, {});

    expect(rows.map((row) => row.sku)).toEqual(["A", "B"]);
    expect(rows[0]?.lastCostFils).toBe(500);
    expect(rows[0]?.lastSalePriceFils).toBe(900);
    expect(rows[1]?.lastCostFils).toBe(700);
    expect(rows[1]?.lastSalePriceFils).toBe(0);
  });
});
