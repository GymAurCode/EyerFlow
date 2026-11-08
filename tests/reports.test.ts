import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, openInMemoryDatabase, type SqliteDatabase } from "../src/data/connection";
import { dashboardSummary, profitAndLoss, stockValuation } from "../src/main/repositories/reports";
import { listProducts } from "../src/main/repositories/products";
import { saveDocument } from "../src/main/repositories/documents";
import { SYSTEM_ACTOR } from "../src/main/audit-writer";
import { migrateInMemory } from "./helpers";

/**
 * Report-layer tests.
 *
 * Reports are where a mismatch between a SQL column alias and the TypeScript
 * field it is read into is most dangerous: nothing throws at the query, the
 * value simply arrives as `undefined`, and the arithmetic quietly becomes NaN.
 * Every report query that aliases a column is therefore exercised here against
 * real data rather than trusted.
 */

let db: SqliteDatabase;

const NOW = "2026-03-01T00:00:00.000Z";

function insertParty(code: string, name: string, kind: "customer" | "supplier"): number {
  const info = db
    .prepare(
      `INSERT INTO parties (code, name, kind, opening_balance, created_at, updated_at)
       VALUES (?, ?, ?, 0, ?, ?)`,
    )
    .run(code, name, kind, NOW, NOW);
  return Number(info.lastInsertRowid);
}

function insertDocument(input: {
  readonly kind: string;
  readonly number: string;
  readonly partyId: number | null;
  readonly issueDate: string;
  readonly netFils: number;
  readonly vatFils: number;
  readonly costFils?: number;
  readonly status?: string;
}): void {
  db.prepare(
    `INSERT INTO documents
       (kind, number, party_id, issue_date, status, net_fils, vat_fils, gross_fils, cost_fils,
        fiscal_year, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 2026, ?, ?)`,
  ).run(
    input.kind,
    input.number,
    input.partyId,
    input.issueDate,
    input.status ?? "issued",
    input.netFils,
    input.vatFils,
    input.netFils + input.vatFils,
    input.costFils ?? 0,
    NOW,
    NOW,
  );
}

function insertExpense(date: string, amountFils: number, vatFils: number): void {
  db.prepare(
    `INSERT INTO expenses (expense_date, category, description, amount_fils, vat_fils, created_at, updated_at)
     VALUES (?, 'general', 'Test expense', ?, ?, ?, ?)`,
  ).run(date, amountFils, vatFils, NOW, NOW);
}

function insertProduct(sku: string, name: string): number {
  const info = db
    .prepare(
      `INSERT INTO products (sku, name, quantity_milli, average_cost_fils, sale_price_fils, created_at, updated_at)
       VALUES (?, ?, 0, 0, 0, ?, ?)`,
    )
    .run(sku, name, NOW, NOW);
  return Number(info.lastInsertRowid);
}

function insertStockedProduct(input: {
  readonly sku: string;
  readonly name: string;
  readonly category: string | null;
  readonly unit: string;
  readonly quantityMilli: number;
  readonly averageCostFils: number;
}): number {
  const info = db
    .prepare(
      `INSERT INTO products
         (sku, name, category, unit, quantity_milli, average_cost_fils, sale_price_fils,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    )
    .run(
      input.sku,
      input.name,
      input.category,
      input.unit,
      input.quantityMilli,
      input.averageCostFils,
      NOW,
      NOW,
    );
  return Number(info.lastInsertRowid);
}

beforeEach(() => {
  db = openInMemoryDatabase();
  migrateInMemory(db);
});

afterEach(() => {
  closeDatabase(db);
});

describe("dashboardSummary", () => {
  it("reports sales, purchases and a positive net profit", () => {
    const customer = insertParty("C-0001", "Aqua Villas", "customer");
    insertDocument({
      kind: "invoice",
      number: "INV-0001",
      partyId: customer,
      issueDate: "2026-02-01",
      netFils: 100_000,
      vatFils: 5_000,
      costFils: 60_000,
    });
    insertExpense("2026-02-02", 10_000, 500);

    const summary = dashboardSummary(
      db,
      { fromDate: "2026-02-01", toDate: "2026-02-28" },
      new Date("2026-03-01T00:00:00.000Z"),
    );

    expect(summary.salesFils).toBe(105_000);
    expect(summary.expensesFils).toBe(10_000);
    // The dashboard defers to the Profit & Loss headline so the two can never
    // disagree: net 100,000 less cost of goods 60,000 less expenses 10,000.
    expect(summary.netProfitFils).toBe(30_000);
    expect(summary.receivablesFils).toBe(105_000);
  });

  it("ignores cancelled documents", () => {
    const customer = insertParty("C-0001", "Aqua Villas", "customer");
    insertDocument({
      kind: "invoice",
      number: "INV-0001",
      partyId: customer,
      issueDate: "2026-02-01",
      netFils: 100_000,
      vatFils: 5_000,
      status: "cancelled",
    });

    const summary = dashboardSummary(
      db,
      { fromDate: "2026-02-01", toDate: "2026-02-28" },
      new Date("2026-03-01T00:00:00.000Z"),
    );
    expect(summary.salesFils).toBe(0);
  });

  it("returns the previous window's sales without a second summary", () => {
    const customer = insertParty("C-0001", "Aqua Villas", "customer");
    insertDocument({
      kind: "invoice",
      number: "INV-0001",
      partyId: customer,
      issueDate: "2026-02-10",
      netFils: 50_000,
      vatFils: 2_500,
    });
    insertDocument({
      kind: "invoice",
      number: "INV-0002",
      partyId: customer,
      issueDate: "2026-01-10",
      netFils: 25_000,
      vatFils: 1_250,
    });

    const summary = dashboardSummary(
      db,
      {
        fromDate: "2026-02-01",
        toDate: "2026-02-28",
        previousFromDate: "2026-01-01",
        previousToDate: "2026-01-31",
      },
      new Date("2026-03-01T00:00:00.000Z"),
    );

    expect(summary.salesFils).toBe(52_500);
    expect(summary.previousSalesFils).toBe(26_250);
  });

  it("aggregates the dashboard's inventory in SQL", () => {
    insertStockedProduct({
      sku: "A",
      name: "A",
      category: "Filters",
      unit: "pcs",
      quantityMilli: 3_000,
      averageCostFils: 1_234,
    });
    insertStockedProduct({
      sku: "B",
      name: "B",
      category: "Filters",
      unit: "pcs",
      quantityMilli: 2_000,
      averageCostFils: 500,
    });
    insertStockedProduct({
      sku: "C",
      name: "C",
      category: null,
      unit: "kg",
      quantityMilli: 1_000,
      averageCostFils: 0,
    });
    insertStockedProduct({
      sku: "D",
      name: "D",
      category: "  ",
      unit: "kg",
      quantityMilli: 6_000,
      averageCostFils: 100,
    });
    insertStockedProduct({
      sku: "E",
      name: "E",
      category: "Fittings",
      unit: "pcs",
      quantityMilli: 100,
      averageCostFils: 0,
    });

    const summary = dashboardSummary(
      db,
      {
        fromDate: "2026-02-01",
        toDate: "2026-02-28",
        includeInventory: true,
      },
      new Date("2026-03-01T00:00:00.000Z"),
    );

    expect(summary.inventory.productCount).toBe(5);
    expect(summary.inventory.totalQuantityMilli).toBe(12_100);
    expect(summary.inventory.stockedCount).toBe(5);
    expect(summary.inventory.totalStockValueFils).toBe(5_302);
    expect(summary.inventory.units).toEqual(["kg", "pcs"]);
    expect(summary.inventory.categories).toEqual([
      { name: "Filters", count: 2, valueFils: 4_702 },
      { name: "Fittings", count: 1, valueFils: 0 },
      { name: "Uncategorised", count: 2, valueFils: 600 },
    ]);
    expect(summary.inventory.recentProducts.map((product) => product.sku)).toEqual([
      "E",
      "D",
      "C",
      "B",
      "A",
    ]);
    expect(summary.inventory.lowStockProducts.map((product) => product.sku)).toEqual([
      "A",
      "B",
      "C",
    ]);
  });

  it("omits inventory when the caller cannot see products", () => {
    insertStockedProduct({
      sku: "A",
      name: "A",
      category: "Filters",
      unit: "pcs",
      quantityMilli: 3_000,
      averageCostFils: 1_000,
    });

    const summary = dashboardSummary(
      db,
      { fromDate: "2026-02-01", toDate: "2026-02-28" },
      new Date("2026-03-01T00:00:00.000Z"),
    );

    expect(summary.inventory.productCount).toBe(0);
    expect(summary.inventory.recentProducts).toEqual([]);
  });
});

describe("profitAndLoss", () => {
  it("splits revenue, cost of goods and operating expenses", () => {
    const customer = insertParty("C-0001", "Aqua Villas", "customer");
    insertDocument({
      kind: "invoice",
      number: "INV-0001",
      partyId: customer,
      issueDate: "2026-02-01",
      netFils: 100_000,
      vatFils: 5_000,
      costFils: 60_000,
    });
    insertExpense("2026-02-02", 10_000, 500);

    const pnl = profitAndLoss(db, "2026-02-01", "2026-02-28");

    // Revenue is stated net of VAT: VAT is the authority's money, not income.
    expect(pnl.revenueFils).toBe(100_000);
    expect(pnl.netSalesFils).toBe(100_000);
    expect(pnl.costOfGoodsFils).toBe(60_000);
    expect(pnl.grossProfitFils).toBe(40_000);
    expect(pnl.operatingExpensesFils).toBe(10_000);
    expect(pnl.netProfitFils).toBe(30_000);
  });

  it("excludes documents outside the period", () => {
    const customer = insertParty("C-0001", "Aqua Villas", "customer");
    insertDocument({
      kind: "invoice",
      number: "INV-0001",
      partyId: customer,
      issueDate: "2026-02-01",
      netFils: 100_000,
      vatFils: 5_000,
      costFils: 60_000,
    });

    const pnl = profitAndLoss(db, "2026-01-01", "2026-01-31");

    expect(pnl.revenueFils).toBe(0);
    expect(pnl.netSalesFils).toBe(0);
    expect(pnl.costOfGoodsFils).toBe(0);
    expect(pnl.netProfitFils).toBe(0);
  });
});

describe("stockValuation", () => {
  it("values stock at the last purchase cost", () => {
    const now = "2026-02-01T00:00:00.000Z";
    const supplier = insertParty("S-0001", "Supplier", "supplier");
    const product = insertProduct("RO-1", "Purifier");

    // A purchase at 45.00 sets the reference cost; the report values the
    // 10 units on hand at that last cost.
    saveDocument(
      {
        db,
        actor: SYSTEM_ACTOR,
        fiscalYearStartMonth: 1,
        nowIso: now,
        nowDate: "2026-02-01",
        allowNegativeStock: false,
        vatRate: 0.05,
      },
      {
        kind: "purchaseInvoice",
        partyId: supplier,
        issueDate: "2026-02-01",
        dueDate: null,
        status: "issued",
        notes: null,
        reason: null,
        lines: [
          {
            productId: product,
            description: "Purifier",
            quantityMilli: 10_000,
            unitPriceFils: 45_000,
            vatTreatment: "standard",
            unitCostFils: 45_000,
          },
        ],
      } as never,
    );

    // The report reads the mapped product rows, exactly as the UI does.
    const rows = stockValuation(db, listProducts(db, {}));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.quantityMilli).toBe(10_000);
    expect(rows[0]?.valueFils).toBe(450_000);
  });
});
