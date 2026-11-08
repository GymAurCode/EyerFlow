import { expect, test } from "@playwright/test";
import { completeSetup, launchApp, navigateTo, rpc, type TestApp, todayIso } from "./app";

/**
 * The Finance module, driven the way a shopkeeper drives it.
 *
 * The engine is tested in the unit suite; this file is about the screens. It
 * records a purchase, a sale, a receipt and an expense through the same RPC
 * calls the screens use, then opens the Finance pages and checks that the
 * figures on them are the figures that were entered.
 *
 * That distinction matters: a module whose arithmetic is right but whose
 * screens show nothing is not a module a shop can use.
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
  });
  return created.id;
}

async function seedProduct(name: string, sku: string): Promise<number> {
  const created = await rpc<{ id: number }>(testApp.window, "products.save", {
    name,
    sku,
    barcode: null,
    description: null,
    category: "Filters",
    reorderLevelMilli: 2_000,
    salePriceFils: 15_000,
    vatTreatment: "zero",
    openingQuantityMilli: 0,
  });
  return created.id;
}

test.beforeEach(async () => {
  testApp = await launchApp();
  await completeSetup(testApp.window);
});

test.afterEach(async () => {
  await testApp?.close();
});

test("the finance screens show the numbers that were entered", async () => {
  const supplierId = await seedParty("supplier", "Gulf Filtration Supplies");
  const customerId = await seedParty("customer", "Sunrise Villa Complex");
  const productId = await seedProduct("Inline filter", "FLT-001");

  // Buy 10 filters at Rs 40 each: Rs 400 of stock, owed to the supplier.
  const purchase = await rpc<{ id: number; grossFils: number }>(
    testApp.window,
    "documents.save",
    {
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
          vatTreatment: "zero",
          unitCostFils: 4_000,
        },
      ],
    },
  );
  expect(purchase.grossFils).toBe(40_000);

  // Pay the supplier Rs 100 of it.
  await rpc(testApp.window, "payments.save", {
    direction: "outbound",
    partyId: supplierId,
    paymentDate: TODAY,
    method: "cash",
    amountFils: 10_000,
    reference: "PAY-1",
    notes: null,
    allocations: [{ documentId: purchase.id, amountFils: 10_000 }],
  });

  // Sell 4 of them at Rs 75: Rs 300 of revenue, Rs 160 of cost.
  const invoice = await rpc<{ id: number; grossFils: number }>(testApp.window, "documents.save", {
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
        vatTreatment: "zero",
        unitCostFils: 4_000,
      },
    ],
  });
  expect(invoice.grossFils).toBe(30_000);

  // Take Rs 100 from the customer.
  await rpc(testApp.window, "payments.save", {
    direction: "inbound",
    partyId: customerId,
    paymentDate: TODAY,
    method: "cash",
    amountFils: 10_000,
    reference: "RCP-1",
    notes: null,
    allocations: [{ documentId: invoice.id, amountFils: 10_000 }],
  });

  // And a rent bill of Rs 50.
  await rpc(testApp.window, "expenses.save", {
    expenseDate: TODAY,
    category: "rent",
    description: "Shop rent",
    amountFils: 5_000,
    paymentMethod: "cash",
    reference: null,
    notes: null,
  });

  // --- The overview -------------------------------------------------------
  await navigateTo(testApp.window, /^Finance$/i);
  await testApp.window.getByRole("heading", { name: "Finance overview" }).waitFor({ timeout: 30_000 });

  // Revenue of Rs 300, expenses of Rs 50, gross profit Rs 140, net Rs 90.
  const overview = await rpc<{
    readonly metrics: readonly { readonly key: string; readonly amountFils: number }[];
    readonly reconciliation: {
      readonly receivableMatches: boolean;
      readonly payableMatches: boolean;
    };
  }>(testApp.window, "finance.overview", {
    fromDate: MONTH_START,
    toDate: TODAY,
    asOfDate: TODAY,
    previousFromDate: "2020-01-01",
    previousToDate: "2020-01-31",
  });

  const metric = (key: string): number =>
    overview.metrics.find((row) => row.key === key)?.amountFils ?? -1;

  expect(metric("revenue")).toBe(30_000);
  expect(metric("expenses")).toBe(5_000);
  expect(metric("netProfit")).toBe(9_000);
  // The till is short by Rs 50: 100 paid out, 100 received, 50 of rent, and
  // no opening float.
  expect(metric("cash")).toBe(-5_000);
  // The customer still owes Rs 200, the business still owes Rs 300.
  expect(metric("receivable")).toBe(20_000);
  expect(metric("payable")).toBe(30_000);

  // Six figures, and no more.
  expect(overview.metrics).toHaveLength(6);
  expect(overview.metrics.map((row) => row.key)).toEqual([
    "cash",
    "receivable",
    "payable",
    "revenue",
    "expenses",
    "netProfit",
  ]);

  // The control accounts agree with the customer and supplier accounts.
  expect(overview.reconciliation.receivableMatches).toBe(true);
  expect(overview.reconciliation.payableMatches).toBe(true);

  // The screen shows the revenue figure.
  await testApp.window.getByText("Rs 300.00").first().waitFor({ timeout: 30_000 });

  // --- The chart of accounts ----------------------------------------------
  await navigateTo(testApp.window, /^Finance$/i);
  await testApp.window.getByRole("link", { name: "Chart of Accounts" }).click();
  await testApp.window.getByRole("heading", { name: "Chart of Accounts" }).waitFor({ timeout: 30_000 });
  await testApp.window.getByText("Accounts Receivable").first().waitFor({ timeout: 30_000 });
  await testApp.window.getByText("Cost of Goods Sold").first().waitFor({ timeout: 30_000 });

  // --- The journal --------------------------------------------------------
  await testApp.window.getByRole("link", { name: "Journal Entries" }).click();
  await testApp.window.getByRole("heading", { name: "Journal entries" }).waitFor({ timeout: 30_000 });
  await testApp.window.getByText("Sale").first().waitFor({ timeout: 30_000 });
  await testApp.window.getByText("Purchase").first().waitFor({ timeout: 30_000 });

  // --- The ledgers --------------------------------------------------------
  await testApp.window.getByRole("link", { name: "Customer Receivables" }).click();
  await testApp.window
    .getByRole("heading", { name: "Customer receivables" })
    .waitFor({ timeout: 30_000 });
  await testApp.window.getByText("Sunrise Villa Complex").first().waitFor({ timeout: 30_000 });

  await testApp.window.getByRole("link", { name: "Supplier Payables" }).click();
  await testApp.window
    .getByRole("heading", { name: "Supplier payables" })
    .waitFor({ timeout: 30_000 });
  await testApp.window.getByText("Gulf Filtration Supplies").first().waitFor({ timeout: 30_000 });

  // --- Bank and cash ------------------------------------------------------
  await testApp.window.getByRole("link", { name: "Bank & Cash" }).click();
  await testApp.window.getByRole("heading", { name: "Bank & cash" }).waitFor({ timeout: 30_000 });
  // 100 paid out, 100 received, and 50 of rent: the till is empty.
  await testApp.window.getByText("Rs 0.00").first().waitFor({ timeout: 30_000 });

  // --- The reports --------------------------------------------------------
  await testApp.window.getByRole("link", { name: "Financial Reports" }).click();
  await testApp.window.getByRole("heading", { name: "Financial reports" }).waitFor({ timeout: 30_000 });
  await testApp.window.getByText("Trial balance").first().waitFor({ timeout: 30_000 });
  // A balanced trial balance says so.
  await testApp.window.getByText("Debits equal credits").first().waitFor({ timeout: 30_000 });

  await testApp.window.getByRole("button", { name: "Profit & loss" }).click();
  await testApp.window.getByText("Gross profit").first().waitFor({ timeout: 30_000 });
  await testApp.window.getByText("Net profit").first().waitFor({ timeout: 30_000 });

  await testApp.window.getByRole("button", { name: "Balance sheet" }).click();
  await testApp.window.getByText("Assets equal liabilities plus equity").first().waitFor({
    timeout: 30_000,
  });
});

test("the chart of accounts folds and unfolds", async () => {
  await navigateTo(testApp.window, /^Finance$/i);
  await testApp.window.getByRole("link", { name: "Chart of Accounts" }).click();
  await testApp.window.getByRole("heading", { name: "Chart of Accounts" }).waitFor({ timeout: 30_000 });

  // A parent account with a sub-account under it.
  const parent = await rpc<{ id: number; code: string }>(testApp.window, "finance.chart.save", {
    code: "1600",
    name: "Vehicles & Equipment",
    type: "asset",
    subtype: "fixedAsset",
    description: "Tools, vehicles and fittings.",
  });

  await rpc(testApp.window, "finance.chart.save", {
    code: "1610",
    name: "Delivery Vehicles",
    type: "asset",
    subtype: "fixedAsset",
    parentId: parent.id,
  });

  // The screen reloads so the chart is fetched afresh: the accounts above
  // were created through the bridge, not through the editor, so nothing has
  // told the page's cache that they exist.
  await testApp.window.reload();
  await testApp.window.getByRole("heading", { name: "Chart of Accounts" }).waitFor({ timeout: 30_000 });

  const chart = await rpc<readonly { code: string; parentId: number | null }[]>(
    testApp.window,
    "finance.chart",
    {},
  );
  const child = chart.find((row) => row.code === "1610");
  expect(child?.parentId).toBe(parent.id);

  // The sub-account starts visible, indented under its parent.
  await testApp.window.getByText("Delivery Vehicles").first().waitFor({ timeout: 30_000 });
  await testApp.window.getByText("Vehicles & Equipment").first().waitFor({ timeout: 30_000 });

  // Folding the branch closes it and keeps the parent.
  await testApp.window.getByRole("button", { name: "Collapse Vehicles & Equipment" }).click();
  await expect(
    testApp.window.getByRole("button", { name: "Expand Vehicles & Equipment" }),
  ).toBeVisible();
  await testApp.window.getByText("Vehicles & Equipment").first().waitFor({ timeout: 20_000 });

  // Opening it again brings the sub-account back.
  await testApp.window.getByRole("button", { name: "Expand Vehicles & Equipment" }).click();
  await testApp.window.getByText("Delivery Vehicles").first().waitFor({ timeout: 20_000 });
  await expect(
    testApp.window.getByRole("button", { name: "Collapse Vehicles & Equipment" }),
  ).toBeVisible();

  // And the toolbar can fold the whole chart up and open it again.
  await testApp.window.getByRole("button", { name: "Collapse all" }).click();
  await expect(testApp.window.getByRole("button", { name: /^Assets/ })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await testApp.window.getByText("Vehicles & Equipment").first().waitFor({ timeout: 20_000 });

  await testApp.window.getByRole("button", { name: "Expand all" }).click();
  await expect(testApp.window.getByRole("button", { name: /^Assets/ })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await testApp.window.getByText("Delivery Vehicles").first().waitFor({ timeout: 20_000 });
});

test("a manual journal entry balances before it is posted", async () => {
  await navigateTo(testApp.window, /^Finance$/i);
  await testApp.window.getByRole("link", { name: "Journal Entries" }).click();
  await testApp.window.getByRole("heading", { name: "Journal entries" }).waitFor({ timeout: 30_000 });

  await testApp.window.getByRole("button", { name: "New entry" }).click();
  const dialog = testApp.window.getByRole("dialog");
  await dialog.getByLabel("Date").fill(TODAY);
  await dialog.getByLabel("Explanation").fill("Opening cash");

  // The account pickers are listbox buttons and the amounts are money inputs.
  const accounts = dialog.getByRole("combobox");
  const amounts = dialog.locator('input[inputmode="decimal"]');

  await accounts.nth(0).click();
  await testApp.window.getByRole("option", { name: /1000 — Cash in Hand/ }).click();
  // The money inputs run debit, credit, debit, credit down the two lines.
  await amounts.nth(0).fill("100");

  await accounts.nth(1).click();
  await testApp.window.getByRole("option", { name: /3000 — Owner/ }).click();
  await amounts.nth(3).fill("100");

  // The editor says it balances, and the Post button is therefore live.
  await testApp.window.getByText("Balanced").first().waitFor({ timeout: 20_000 });

  await testApp.window.getByRole("button", { name: "Post", exact: true }).click();
  await testApp.window.getByText("Opening cash").first().waitFor({ timeout: 30_000 });

  // The entry is on the books, and the trial balance still balances.
  const trial = await rpc<{ readonly isBalanced: boolean }>(
    testApp.window,
    "finance.trialBalance",
    { fromDate: MONTH_START, toDate: TODAY },
  );
  expect(trial.isBalanced).toBe(true);
});
