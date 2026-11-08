import { expect, test } from "@playwright/test";
import { completeSetup, launchApp, rpc, type TestApp, todayIso } from "./app";

/**
 * The core trading round trip.
 *
 * Purchase stock, sell it, then confirm the reports show the margin and the
 * stock level fell by exactly what was sold. This is the single test that would
 * catch a regression in costing, VAT or stock posting all at once, because every
 * one of those has to be right for the numbers to reconcile.
 */

let testApp: TestApp;

const TODAY = todayIso();
const MONTH_START = `${TODAY.slice(0, 7)}-01`;

async function seedParty(kind: "customer" | "supplier", name: string): Promise<number> {
  const created = await rpc<{ id: number }>(testApp.window, "parties.save", {
    kind,
    name,
    phone: null,
    email: null,
    trn: null,
    addressLine: null,
    emirate: null,
  });
  return created.id;
}

async function seedProduct(name: string, sku: string): Promise<number> {
  const created = await rpc<{ id: number }>(testApp.window, "products.save", {
    name,
    nameAr: null,
    sku,
    barcode: null,
    description: null,
    category: "Filters",
    reorderLevelMilli: 2_000,
    salePriceFils: 7_500,
    vatTreatment: "standard",
    isSerialised: false,
    isService: false,
    warrantyMonths: 12,
  });
  return created.id;
}

interface DocumentResult {
  readonly id: number;
  readonly number: string;
  readonly netFils: number;
  readonly vatFils: number;
  readonly grossFils: number;
  readonly costFils: number;
}

async function saveDocument(request: Record<string, unknown>): Promise<DocumentResult> {
  return rpc<DocumentResult>(testApp.window, "documents.save", request);
}

test.beforeEach(async () => {
  testApp = await launchApp();
  await completeSetup(testApp.window);
});

test.afterEach(async () => {
  await testApp?.close();
});

test("purchase then sale flows through to the profit report", async () => {
  const supplierId = await seedParty("supplier", "Gulf Filtration Supplies");
  const customerId = await seedParty("customer", "Sunrise Villa Complex");
  const productId = await seedProduct("Inline filter", "FLT-001");

  // Purchase 10 filters at Rs 40 cost.
  const purchase = await saveDocument({
    kind: "purchaseInvoice",
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
        quantityMilli: 10_000,
        unitPriceFils: 4_000,
        vatTreatment: "standard",
        unitCostFils: 4_000,
      },
    ],
  });

  expect(purchase.number).toMatch(/^PINV-/);
  expect(purchase.netFils).toBe(40_000);
  expect(purchase.vatFils).toBe(2_000);
  expect(purchase.grossFils).toBe(42_000);

  // The purchase must have landed in stock at its cost.
  const afterPurchase = await rpc<
    readonly { id: number; quantityMilli: number; averageCostFils: number }[]
  >(testApp.window, "products.list", { limit: 100 });
  expect(afterPurchase.find((row) => row.id === productId)?.quantityMilli).toBe(10_000);
  expect(afterPurchase.find((row) => row.id === productId)?.averageCostFils).toBe(4_000);

  // Sell 4 of them at Rs 75, having bought at Rs 40. The cost is entered on
  // the line (cost_at_sale) and is what profit and COGS use - there is no
  // weighted average any more.
  const invoice = await saveDocument({
    kind: "invoice",
    partyId: customerId,
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
        unitCostFils: 4_000,
      },
    ],
  });

  expect(invoice.number).toMatch(/^INV-/);
  // 4 x 75.00 = 300.00 net, 15.00 VAT, 315.00 gross.
  expect(invoice.netFils).toBe(30_000);
  expect(invoice.vatFils).toBe(1_500);
  expect(invoice.grossFils).toBe(31_500);
  // Cost of the 4 units at the purchase price: 4 x 40.00.
  expect(invoice.costFils).toBe(16_000);

  // Stock must have fallen by exactly the quantity sold.
  const afterSale = await rpc<
    readonly { id: number; quantityMilli: number; stockValueFils: number }[]
  >(testApp.window, "products.list", { limit: 100 });
  const remaining = afterSale.find((row) => row.id === productId);
  expect(remaining?.quantityMilli).toBe(6_000);
  expect(remaining?.stockValueFils).toBe(24_000);

  // The profit report must reconcile to the same numbers.
  const pnl = await rpc<{
    revenueFils: number;
    costOfGoodsFils: number;
    grossProfitFils: number;
    netProfitFils: number;
  }>(testApp.window, "reports.profitAndLoss", { fromDate: MONTH_START, toDate: TODAY });

  expect(pnl.revenueFils).toBe(30_000);
  expect(pnl.costOfGoodsFils).toBe(16_000);
  expect(pnl.grossProfitFils).toBe(14_000);
  expect(pnl.netProfitFils).toBe(14_000);

  // Net sales + VAT must equal the invoice total exactly.
  expect(pnl.revenueFils + 1_500).toBe(invoice.grossFils);
});

test("last cost follows the most recent purchase", async () => {
  const supplierId = await seedParty("supplier", "Gulf Filtration Supplies");
  const productId = await seedProduct("Inline filter", "FLT-001");

  const post = async (quantityMilli: number, unitCostFils: number): Promise<void> => {
    await saveDocument({
      kind: "purchaseInvoice",
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
          quantityMilli,
          unitPriceFils: unitCostFils,
          vatTreatment: "standard",
          unitCostFils,
        },
      ],
    });
  };

  await post(10_000, 4_000);
  await post(10_000, 6_000);

  const rows = await rpc<readonly { id: number; quantityMilli: number; averageCostFils: number }[]>(
    testApp.window,
    "products.list",
    { limit: 100 },
  );
  const product = rows.find((row) => row.id === productId);

  expect(product?.quantityMilli).toBe(20_000);
  // Last cost, not the 50.00 weighted average the two purchases would imply.
  expect(product?.averageCostFils).toBe(6_000);

  // And the read-only "last cost" column is derived from the purchase lines.
  const withHistory = await rpc<
    readonly { id: number; lastCostFils: number; lastSalePriceFils: number }[]
  >(testApp.window, "products.list", { limit: 100 });
  expect(withHistory.find((row) => row.id === productId)?.lastCostFils).toBe(6_000);
});

test("a stock adjustment moves stock without revaluing it", async () => {
  // Credit notes and returns were removed in the 0.3.0 simplification, so a
  // stock adjustment is how stock moves outside a purchase or a sale. The line
  // is a delta, not a counted total, and it is valued at the average cost the
  // position already carries - a count does not restate what stock cost.
  const supplierId = await seedParty("supplier", "Gulf Filtration Supplies");
  const productId = await seedProduct("Inline filter", "FLT-001");

  await saveDocument({
    kind: "purchaseInvoice",
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
        quantityMilli: 10_000,
        unitPriceFils: 4_000,
        vatTreatment: "standard",
        unitCostFils: 4_000,
      },
    ],
  });

  // A count finds three more units than the system holds.
  const adjustment = await saveDocument({
    kind: "stockAdjustment",
    partyId: null,
    issueDate: TODAY,
    dueDate: null,
    status: "issued",
    notes: "Stock count",
    reason: null,
    lines: [
      {
        productId,
        description: "Inline filter",
        quantityMilli: 3_000,
        unitPriceFils: 0,
        vatTreatment: "standard",
      },
    ],
  });

  expect(adjustment.number).toMatch(/^ADJ-/);

  const rows = await rpc<readonly { id: number; quantityMilli: number; averageCostFils: number }[]>(
    testApp.window,
    "products.list",
    { limit: 100 },
  );
  const product = rows.find((row) => row.id === productId);

  expect(product?.quantityMilli).toBe(13_000);
  expect(product?.averageCostFils).toBe(4_000);
});

test("the reports screen shows the profit the sale created", async () => {
  const supplierId = await seedParty("supplier", "Gulf Filtration Supplies");
  const customerId = await seedParty("customer", "Sunrise Villa Complex");
  const productId = await seedProduct("Inline filter", "FLT-002");

  await saveDocument({
    kind: "purchaseInvoice",
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
        quantityMilli: 10_000,
        unitPriceFils: 4_000,
        vatTreatment: "standard",
        unitCostFils: 4_000,
      },
    ],
  });

  await saveDocument({
    kind: "invoice",
    partyId: customerId,
    issueDate: TODAY,
    dueDate: null,
    status: "issued",
    notes: null,
    reason: null,
    lines: [
      {
        productId,
        description: "Inline filter",
        quantityMilli: 2_000,
        unitPriceFils: 7_500,
        vatTreatment: "standard",
        unitCostFils: 4_000,
      },
    ],
  });

  // Walk to Reports through the sidebar, as a user would.
  await testApp.window
    .getByRole("complementary", { name: "Main navigation" })
    .getByRole("button", { name: "Reporting", exact: true })
    .click();
  await testApp.window
    .getByRole("link", { name: "Inventory & Sales Reports", exact: true })
    .first()
    .click();
  await expect(testApp.window.getByText("Profit & Loss").first()).toBeVisible();

  // The report is generated from the live database and shown as the document
  // that will be printed.
  await testApp.window.getByRole("button", { name: /generate report/i }).click();
  const frame = testApp.window.frameLocator('iframe[title$="preview"]');
  await expect(frame.locator(".doc-title")).toHaveText("Profit and Loss");

  // 150.00 revenue, 80.00 cost of goods (2 units at the 40.00 cost entered on
  // the sale line), 70.00 net profit. The line has to name a product and carry
  // a cost for there to be a cost of goods to report: an unlinked line is a
  // free-text note, not stock.
  await expect(frame.getByText("150.00").first()).toBeVisible();
  await expect(frame.getByText("80.00").first()).toBeVisible();
  await expect(frame.getByText("70.00").first()).toBeVisible();
});

test("the dashboard reflects today's sale", async () => {
  const customerId = await seedParty("customer", "Sunrise Villa Complex");

  await saveDocument({
    kind: "invoice",
    partyId: customerId,
    issueDate: TODAY,
    dueDate: null,
    status: "issued",
    notes: null,
    reason: null,
    lines: [
      {
        productId: null,
        description: "Installation service",
        quantityMilli: 1_000,
        unitPriceFils: 50_000,
        vatTreatment: "standard",
      },
    ],
  });

  await testApp.window
    .getByRole("link", { name: /^dashboard$/i })
    .first()
    .click();

  // Reload rather than only clicking through: the dashboard's query is cached
  // for 30 seconds, so navigating inside that window would show the figures
  // from before the sale. A reload is the honest way to ask what the dashboard
  // says now.
  await testApp.window.reload();
  await testApp.window.getByRole("navigation").first().waitFor({ timeout: 30_000 });

  await expect(testApp.window.getByRole("heading", { name: "Dashboard" }).last()).toBeVisible();
  // Rs 500.00 net plus Rs 25.00 VAT, shown gross.
  await expect(testApp.window.getByText("Rs 525.00").first()).toBeVisible();
  // The dashboard's KPI tiles. "Sales Today" is one of the five.
  await expect(testApp.window.getByText("Sales Today").first()).toBeVisible();
});

test("a document is refused when its kind is not one the app supports", async () => {
  // Credit notes, quotations and returns were removed in the 0.3.0
  // simplification, and the request schema is what actually enforces that. A
  // removed feature that still reached the database would put a document kind
  // in a shop's books that no screen can show or reverse.
  const supplierId = await seedParty("supplier", "Gulf Filtration Supplies");

  const result = await testApp.window.evaluate(
    async ([supplier, date]) => {
      const api = (
        window as unknown as {
          api: { invoke: (m: string, p: unknown) => Promise<unknown> };
        }
      ).api;
      return (await api.invoke("documents.save", {
        kind: "creditNote",
        partyId: supplier,
        issueDate: date,
        dueDate: null,
        status: "issued",
        notes: null,
        reason: null,
        lines: [
          {
            productId: null,
            description: "Unsupported kind",
            quantityMilli: 1_000,
            unitPriceFils: 4_000,
            vatTreatment: "standard",
          },
        ],
      })) as { ok: boolean; error?: { code?: string; message?: string } };
    },
    [supplierId, TODAY] as [number, string],
  );

  expect(result.ok).toBe(false);
  expect(result.error?.code).toBe("VALIDATION");
});
