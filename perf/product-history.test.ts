import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDatabase, openInMemoryDatabase, type SqliteDatabase } from "../src/data/connection";
import { migrations } from "../src/data/migrations";
import { runMigrations } from "../src/data/migrator";
import { productCostHistory } from "../src/main/repositories/products";

/**
 * Cost history under load.
 *
 * The catalogue asks for a page, not the whole shop. Reading history for every
 * product line was the old behaviour; the filtered read should be a fraction
 * of it while producing the same values for the rows that were asked for.
 */

const PRODUCT_COUNT = 20_000;
const DOCUMENT_COUNT = 20_000;
const LINES_PER_DOCUMENT = 3;
const PAGE_SIZE = 500;

let db: SqliteDatabase;

beforeAll(() => {
  db = openInMemoryDatabase();
  runMigrations(db, migrations);

  const insertProduct = db.prepare(
    `INSERT INTO products (sku, name, quantity_milli, average_cost_fils, sale_price_fils,
                           created_at, updated_at)
     VALUES (?, ?, 0, 0, 0, ?, ?)`,
  );
  const insertDocument = db.prepare(
    `INSERT INTO documents (kind, number, issue_date, status, net_fils, vat_fils,
                            gross_fils, cost_fils, fiscal_year, created_at, updated_at)
     VALUES (?, ?, ?, 'issued', 0, 0, 0, 0, 2026, ?, ?)`,
  );
  const insertLine = db.prepare(
    `INSERT INTO document_lines (document_id, line_no, product_id, description,
                                 quantity_milli, unit_price_fils, net_fils, vat_fils,
                                 vat_treatment, unit_cost_fils, cost_fils)
     VALUES (?, ?, ?, 'line', 1000, ?, 0, 0, 'standard', 0, 0)`,
  );

  db.transaction(() => {
    for (let index = 1; index <= PRODUCT_COUNT; index += 1) {
      insertProduct.run(
        `SKU-${String(index).padStart(6, "0")}`,
        `Product ${String(index)}`,
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );
    }

    for (let index = 1; index <= DOCUMENT_COUNT; index += 1) {
      const kind = index % 2 === 0 ? "invoice" : "purchaseInvoice";
      const day = String((index % 28) + 1).padStart(2, "0");
      const info = insertDocument.run(
        kind,
        `${kind === "invoice" ? "INV" : "PUR"}-${String(index).padStart(7, "0")}`,
        `2026-02-${day}`,
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );
      const documentId = Number(info.lastInsertRowid);
      for (let line = 1; line <= LINES_PER_DOCUMENT; line += 1) {
        const productId = ((index + line) % PRODUCT_COUNT) + 1;
        insertLine.run(documentId, line, productId, 1_000 + (index % 500));
      }
    }
  })();
});

afterAll(() => {
  closeDatabase(db);
});

describe("product cost history", () => {
  it("reads a page's history without walking the whole catalogue", () => {
    const ids = Array.from({ length: PAGE_SIZE }, (_unused, index) => index + 1);

    const allStarted = performance.now();
    const all = productCostHistory(db);
    const allMs = performance.now() - allStarted;

    const pageStarted = performance.now();
    const page = productCostHistory(db, ids);
    const pageMs = performance.now() - pageStarted;

    console.error(
      `PRODUCT_HISTORY all=${allMs.toFixed(1)}ms page=${pageMs.toFixed(1)}ms ` +
        `rows=${String(all.size)}/${String(page.size)}`,
    );

    expect(page.size).toBeLessThanOrEqual(PAGE_SIZE);
    for (const id of ids) {
      expect(page.get(id)).toEqual(all.get(id));
    }
    expect(pageMs).toBeLessThan(allMs);
  });
});
