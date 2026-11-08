import { expect, test } from "@playwright/test";
import { completeSetup, launchApp, navigateTo, rpc, type TestApp, todayIso } from "./app";

/**
 * The Chart of Accounts as a master-detail screen.
 *
 * The chart is the spine of the Finance module, so the two things worth
 * protecting here are the hierarchy (what folds, what a search finds) and the
 * figures on the right (which must be the ledger's own, not a second set of
 * numbers calculated somewhere else).
 */

let testApp: TestApp;

const TODAY = todayIso();
const MONTH_START = `${TODAY.slice(0, 7)}-01`;

/** The chart panel, so a query never wanders into the global search. */
function chartPanel(): ReturnType<TestApp["window"]["locator"]> {
  return testApp.window.getByRole("region", { name: "Chart of accounts" });
}

async function openChart(): Promise<void> {
  await navigateTo(testApp.window, /^Finance$/i);
  await testApp.window.getByRole("link", { name: "Chart of Accounts" }).click();
  await testApp.window.getByRole("heading", { name: "Chart of Accounts" }).waitFor({
    timeout: 30_000,
  });
}

/** A customer and a product, so a sale can be posted. */
async function seedSale(): Promise<number> {
  const customer = await rpc<{ id: number }>(testApp.window, "parties.save", {
    kind: "customer",
    name: "Sunrise Villa Complex",
    phone: null,
    email: null,
    trn: null,
    addressLine: null,
  });
  const product = await rpc<{ id: number }>(testApp.window, "products.save", {
    name: "Inline filter",
    sku: "FLT-001",
    barcode: null,
    description: null,
    category: "Filters",
    reorderLevelMilli: 2_000,
    salePriceFils: 7_500,
    vatTreatment: "zero",
    openingQuantityMilli: 10_000,
  });

  await rpc(testApp.window, "documents.save", {
    kind: "invoice",
    partyId: customer.id,
    issueDate: TODAY,
    dueDate: null,
    status: "issued",
    notes: null,
    reason: null,
    lines: [
      {
        productId: product.id,
        description: "Inline filter",
        quantityMilli: 4_000,
        unitPriceFils: 7_500,
        vatTreatment: "zero",
        unitCostFils: 4_000,
      },
    ],
  });

  return customer.id;
}

test.beforeEach(async () => {
  testApp = await launchApp();
  await completeSetup(testApp.window);
});

test.afterEach(async () => {
  await testApp?.close();
});

test("the chart folds and unfolds, and a search finds a nested account", async () => {
  await openChart();

  // The five categories, in the order the balance sheet uses.
  for (const category of ["Assets", "Liabilities", "Equity", "Income", "Expenses"]) {
    await expect(chartPanel().getByText(category, { exact: true })).toBeVisible();
  }
  await expect(chartPanel().getByText("Cash in Hand", { exact: true })).toBeVisible();

  // A sub-account, so the tree has a branch to fold.
  const chart = await rpc<
    readonly { id: number; code: string; name: string }[]
  >(testApp.window, "finance.chart", {});
  const cash = chart.find((account) => account.code === "1000");
  await rpc(testApp.window, "finance.chart.save", {
    code: "1050",
    name: "Petty Cash",
    type: "asset",
    subtype: "currentAsset",
    parentId: cash?.id ?? null,
    description: "Cash in the till.",
  });
  await testApp.window.reload();
  await openChart();

  // The branch folds from its own chevron, and folding it does not select
  // the account.
  await chartPanel().getByRole("button", { name: "Collapse Cash in Hand" }).click();
  // The chevron says so: it now offers to expand the branch again.
  await expect(chartPanel().getByRole("button", { name: "Expand Cash in Hand" })).toBeVisible();
  // Nothing was selected by clicking the chevron.
  await expect(testApp.window.getByRole("heading", { name: "Cash in Hand" })).toHaveCount(0);

  await chartPanel().getByRole("button", { name: "Expand Cash in Hand" }).click();
  await expect(chartPanel().getByText("Petty Cash", { exact: true })).toBeVisible();

  // Collapse all folds every category; expand all opens them again.
  await chartPanel().getByRole("button", { name: "Collapse all" }).click();
  await expect(chartPanel().getByRole("button", { name: /^Assets/ })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await expect(chartPanel().getByRole("button", { name: /^Expenses/ })).toHaveAttribute(
    "aria-expanded",
    "false",
  );

  await chartPanel().getByRole("button", { name: "Expand all" }).click();
  await expect(chartPanel().getByRole("button", { name: /^Assets/ })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(chartPanel().getByText("Cash in Hand", { exact: true })).toBeVisible();

  // A search finds the nested account and keeps the path to it.
  await chartPanel().getByLabel(/search/i).fill("petty");
  await expect(chartPanel().getByText("Petty Cash", { exact: true })).toBeVisible();
  await expect(chartPanel().getByText("Cash in Hand", { exact: true })).toBeVisible();

  // Clearing it brings the whole chart back.
  await chartPanel().getByLabel(/search/i).fill("");
  await expect(chartPanel().getByText("Bank Account", { exact: true })).toBeVisible();
});

test("selecting an account shows its balance and the ledger behind it", async () => {
  await seedSale();
  await openChart();

  await chartPanel().getByRole("button", { name: /^4000 Sales Revenue$/ }).click();

  // The header says which account this is.
  await expect(testApp.window.getByRole("heading", { name: "Sales Revenue" })).toBeVisible();
  await expect(testApp.window.getByText("Increases with credits")).toBeVisible();

  // The figures are the ledger's own.
  const ledger = await rpc<{
    readonly openingBalanceFils: number;
    readonly totalDebitFils: number;
    readonly totalCreditFils: number;
    readonly closingBalanceFils: number;
    readonly rows: readonly {
      readonly entryNo: string;
      readonly entryDate: string;
      readonly description: string | null;
      readonly debitFils: number;
      readonly creditFils: number;
      readonly runningBalanceFils: number;
    }[];
  }>(testApp.window, "finance.generalLedger", {
    code: "4000",
    fromDate: MONTH_START,
    toDate: TODAY,
  });

  const money = (fils: number): string =>
    new Intl.NumberFormat("en-AE", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(fils / 100);

  // A credit-normal account: the balance is positive and the credit is what
  // made it.
  expect(ledger.totalCreditFils).toBe(30_000);
  expect(ledger.closingBalanceFils).toBe(30_000);

  await expect(testApp.window.getByText(money(ledger.closingBalanceFils)).first()).toBeVisible();

  // The transaction history shows the journal line behind it.
  await testApp.window.getByRole("tab", { name: "Transaction History" }).click();
  const row = ledger.rows[0];
  expect(row).toBeDefined();
  await expect(testApp.window.getByText(row?.entryNo ?? "", { exact: true })).toBeVisible();
  await expect(testApp.window.getByText(row?.entryDate ?? "", { exact: true })).toBeVisible();

  // The running balance in the table is the ledger's running balance.
  await expect(
    testApp.window.getByText(money(ledger.rows[0]?.runningBalanceFils ?? 0)).first(),
  ).toBeVisible();

  // Opening the entry shows the transaction it came from.
  await testApp.window.getByText(row?.entryNo ?? "").click();
  await expect(testApp.window.getByRole("dialog")).toBeVisible();
  await expect(testApp.window.getByRole("dialog").getByText("Accounts Receivable")).toBeVisible();
});

test("an account can be added, edited, and a used one cannot be deleted", async () => {
  await seedSale();
  await openChart();

  // --- Add --------------------------------------------------------------
  await chartPanel().getByRole("button", { name: "Add Account" }).click();
  const dialog = testApp.window.getByRole("dialog");
  await dialog.getByLabel("Code").fill("7100");
  await dialog.getByLabel("Name").fill("Marketing Campaign");
  await dialog.getByLabel("Description").fill("Advertising for the new range.");
  await dialog.getByRole("button", { name: "Save" }).click();

  await expect(chartPanel().getByText("Marketing Campaign", { exact: true })).toBeVisible();

  // --- Edit --------------------------------------------------------------
  await chartPanel().getByRole("button", { name: /^7100 Marketing Campaign$/ }).click();
  await testApp.window.getByRole("button", { name: "Edit Account" }).click();
  const editor = testApp.window.getByRole("dialog");
  await editor.getByLabel("Name").fill("Marketing Campaigns");
  await editor.getByRole("button", { name: "Save" }).click();

  await expect(chartPanel().getByText("Marketing Campaigns", { exact: true })).toBeVisible();

  // --- A duplicate code is refused, and says so ----------------------------
  await chartPanel().getByRole("button", { name: "Add Account" }).click();
  const addDialog = testApp.window.getByRole("dialog");
  await addDialog.getByLabel("Code").fill("7100");
  await addDialog.getByLabel("Name").fill("A Second Marketing Account");
  await addDialog.getByRole("button", { name: "Save" }).click();

  // The refusal is shown on the field it is about.
  await expect(addDialog.getByText(/already used/i)).toBeVisible();
  await addDialog.getByRole("button", { name: "Cancel" }).click();

  // --- An account with history is deactivated, never deleted ---------------
  await chartPanel().getByRole("button", { name: /^4000 Sales Revenue$/ }).click();
  await testApp.window.getByRole("button", { name: "Edit Account" }).click();
  const used = testApp.window.getByRole("dialog");
  await expect(used.getByText(/ledger line/i).first()).toBeVisible();
  await expect(used.getByRole("button", { name: "Delete" })).toHaveCount(0);
  await expect(used.getByRole("button", { name: "Deactivate" })).toBeVisible();
  await used.getByRole("button", { name: "Cancel" }).click();
});

test("View Ledger opens the ledger for that account and back again", async () => {
  await seedSale();
  await openChart();

  await chartPanel().getByRole("button", { name: /^4000 Sales Revenue$/ }).click();
  await testApp.window.getByRole("button", { name: "View Ledger" }).click();

  // The ledger arrives with the account and the period already chosen.
  await testApp.window.getByRole("heading", { name: "Account ledger" }).waitFor({ timeout: 20_000 });
  await expect(testApp.window.getByRole("combobox").first()).toContainText("4000");
  await expect(testApp.window.getByText("Back to Chart of Accounts")).toBeVisible();

  // And it goes back to the same account.
  await testApp.window.getByRole("button", { name: "Back to Chart of Accounts" }).click();
  await testApp.window.getByRole("heading", { name: "Chart of Accounts" }).waitFor({ timeout: 20_000 });
  await expect(testApp.window.getByRole("heading", { name: "Sales Revenue" })).toBeVisible();
});
