import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDatabase, openInMemoryDatabase, type SqliteDatabase } from "../src/data/connection";
import { migrations } from "../src/data/migrations";
import { runMigrations } from "../src/data/migrator";
import { listDocuments } from "../src/main/repositories/documents";

/**
 * Document list under load.
 *
 * The list endpoint used to read `document_lines` once per document. That is
 * invisible on a shop with a hundred invoices and becomes a thousand round
 * trips on one with a thousand. This keeps the batch read honest.
 */

const DOCUMENT_COUNT = 20_000;
const LINES_PER_DOCUMENT = 3;

let db: SqliteDatabase;

beforeAll(() => {
  db = openInMemoryDatabase();
  runMigrations(db, migrations);

  const insertDocument = db.prepare(
    `INSERT INTO documents (kind, number, issue_date, status, net_fils, vat_fils,
                            gross_fils, cost_fils, fiscal_year, created_at, updated_at)
     VALUES ('invoice', ?, ?, 'issued', 100000, 5000, 105000, 60000, 2025, ?, ?)`,
  );
  const insertLine = db.prepare(
    `INSERT INTO document_lines (document_id, line_no, product_id, description,
                                 quantity_milli, unit_price_fils, net_fils, vat_fils,
                                 vat_treatment, unit_cost_fils, cost_fils)
     VALUES (?, ?, NULL, ?, 1000, 100000, 100000, 5000, 'standard', 60000, 60000)`,
  );

  db.transaction(() => {
    for (let index = 1; index <= DOCUMENT_COUNT; index += 1) {
      const day = String((index % 28) + 1).padStart(2, "0");
      const month = String((index % 12) + 1).padStart(2, "0");
      const info = insertDocument.run(
        `INV-${String(index).padStart(7, "0")}`,
        `2025-${month}-${day}`,
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );
      const documentId = Number(info.lastInsertRowid);
      for (let line = 1; line <= LINES_PER_DOCUMENT; line += 1) {
        insertLine.run(documentId, line, `Line ${String(line)}`);
      }
    }
  })();
});

afterAll(() => {
  closeDatabase(db);
});

describe("document list", () => {
  it("reads a thousand documents with their lines", () => {
    const started = performance.now();
    const rows = listDocuments(db, { kind: "invoice", limit: 1000 });
    const ms = performance.now() - started;

    console.error(`DOCUMENT_LIST ${ms.toFixed(1)}ms ${String(rows.length)} rows`);
    expect(rows).toHaveLength(1000);
    expect(rows[0]?.lines).toHaveLength(LINES_PER_DOCUMENT);
    expect(ms).toBeLessThan(750);
  });
});
