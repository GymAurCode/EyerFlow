/**
 * Stock posting through the document repository.
 *
 * These cover the arithmetic as it is actually reached - through
 * `saveDocument`, against a real migrated database - rather than through the
 * domain helpers alone.
 *
 * The costing model is "last cost, cost at sale": a purchase sets the
 * product's reference cost to the price just paid, and a sale stores the cost
 * entered on the line (cost_at_sale) which is what profit and COGS reports use.
 * No weighted average is computed.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { SqliteDatabase } from "../src/data/connection";
import { openInMemoryDatabase } from "../src/data/connection";
import { runMigrations } from "../src/data/migrator";
import { migrations } from "../src/data/migrations";
import { SYSTEM_ACTOR } from "../src/main/audit-writer";
import { saveDocument } from "../src/main/repositories/documents";
import { saveProduct } from "../src/main/repositories/products";
import { saveParty } from "../src/main/repositories/parties";
import type { SaveDocumentRequest } from "../src/shared/types";

const TODAY = "2026-10-11";
const NOW_ISO = `${TODAY}T09:00:00.000Z`;

function context(db: SqliteDatabase) {
  return {
    db,
    actor: SYSTEM_ACTOR,
    fiscalYearStartMonth: 1,
    nowIso: NOW_ISO,
    nowDate: TODAY,
    allowNegativeStock: false,
    vatRate: 0.05,
  };
}

function purchase(
  partyId: number,
  productId: number,
  quantityMilli: number,
  unitCostFils: number,
): SaveDocumentRequest {
  return {
    kind: "purchaseInvoice",
    partyId,
    issueDate: TODAY,
    dueDate: null,
    status: "issued",
    notes: null,
    reason: null,
    lines: [
      {
        productId,
        description: "Inline filter",
        quantityMilli,
        unitPriceFils: unitCostFils,
        vatTreatment: "standard",
        unitCostFils,
      },
    ],
  } as SaveDocumentRequest;
}

function productRow(
  db: SqliteDatabase,
  productId: number,
): {
  quantity_milli: number;
  average_cost_fils: number;
} {
  return db
    .prepare("SELECT quantity_milli, average_cost_fils FROM products WHERE id = ?")
    .get(productId) as { quantity_milli: number; average_cost_fils: number };
}

describe("last cost across purchases", () => {
  let db: SqliteDatabase;
  let supplierId: number;
  let productId: number;

  beforeEach(() => {
    db = openInMemoryDatabase();
    runMigrations(db, migrations);

    supplierId = saveParty(
      db,
      SYSTEM_ACTOR,
      {
        kind: "supplier",
        name: "Gulf Filtration Supplies",
        phone: null,
        email: null,
        trn: null,
        addressLine: null,
      },
      NOW_ISO,
    ).id;

    productId = saveProduct(
      db,
      SYSTEM_ACTOR,
      {
        name: "Inline filter",
        sku: "FLT-001",
        barcode: null,
        description: null,
        category: "Filters",
        reorderLevelMilli: 2_000,
        salePriceFils: 7_500,
        vatTreatment: "standard",
      },
      NOW_ISO,
    ).id;
  });

  it("sets the reference cost from the first purchase", () => {
    saveDocument(context(db), purchase(supplierId, productId, 10_000, 4_000));

    const row = productRow(db, productId);
    expect(row.quantity_milli).toBe(10_000);
    expect(row.average_cost_fils).toBe(4_000);
  });

  it("moves the reference cost to the most recent purchase price", () => {
    saveDocument(context(db), purchase(supplierId, productId, 10_000, 4_000));
    saveDocument(context(db), purchase(supplierId, productId, 10_000, 6_000));

    // Last cost, not a weighted average of 50.00.
    const row = productRow(db, productId);
    expect(row.quantity_milli).toBe(20_000);
    expect(row.average_cost_fils).toBe(6_000);
  });

  it("values a sale at the cost entered on the line, not the reference cost", () => {
    saveDocument(context(db), purchase(supplierId, productId, 10_000, 4_000));

    const invoice = saveDocument(context(db), {
      kind: "invoice",
      partyId: supplierId,
      issueDate: TODAY,
      dueDate: null,
      status: "issued",
      notes: null,
      reason: null,
      lines: [
        {
          productId,
          description: "Inline filter",
          quantityMilli: 4_000,
          unitPriceFils: 7_500,
          vatTreatment: "standard",
          unitCostFils: 4_500,
        },
      ],
    } as SaveDocumentRequest);

    // 4 units at the 45.00 cost entered at sale time, not the 40.00 purchase.
    expect(invoice.costFils).toBe(18_000);
    expect(productRow(db, productId).quantity_milli).toBe(6_000);
  });
});

describe("opening stock", () => {
  let db: SqliteDatabase;
  let productId: number;

  beforeEach(() => {
    db = openInMemoryDatabase();
    runMigrations(db, migrations);

    productId = saveProduct(
      db,
      SYSTEM_ACTOR,
      {
        name: "Inline filter",
        sku: "FLT-001",
        barcode: null,
        description: null,
        category: "Filters",
        openingQuantityMilli: 10_000,
      },
      NOW_ISO,
    ).id;
  });

  it("creates an opening movement so stock is the sum of movements", () => {
    const row = productRow(db, productId);
    expect(row.quantity_milli).toBe(10_000);

    const movements = db
      .prepare("SELECT kind, quantity_milli FROM stock_movements WHERE product_id = ?")
      .all(productId) as { kind: string; quantity_milli: number }[];

    expect(movements).toHaveLength(1);
    expect(movements[0]?.kind).toBe("opening");
    expect(movements[0]?.quantity_milli).toBe(10_000);
  });
});
