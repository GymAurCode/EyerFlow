import { expect, test } from "@playwright/test";
import { completeSetup, launchApp, navigateTo, rpc, type TestApp, todayIso } from "./app";

/**
 * The partner split: 49% each with a 2% donation.
 *
 * The donation and the partners' shares are percentages of the same net
 * profit, so they add up to exactly 100% between them. This is the number the
 * shop reports on, so it is checked against the figures themselves.
 */

let testApp: TestApp;

const TODAY = todayIso();

async function seedProduct(): Promise<number> {
  const created = await rpc<{ id: number }>(testApp.window, "products.save", {
    name: "Inline filter",
    sku: "FLT-001",
    barcode: null,
    description: null,
    category: "Filters",
    reorderLevelMilli: 2_000,
    salePriceFils: 10_000_000,
    vatTreatment: "zero",
    // Opening stock at no cost, so the sale's profit is the whole sale price.
    openingQuantityMilli: 1_000,
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

test("the split gives each partner 49% and the donation 2%", async () => {
  const productId = await seedProduct();

  const customer = await rpc<{ id: number }>(testApp.window, "parties.save", {
    kind: "customer",
    name: "Sunrise Villa Complex",
    phone: null,
    email: null,
    trn: null,
    addressLine: null,
  });

  // A sale of Rs 100,000 that cost nothing, so the profit is Rs 100,000.
  await rpc(testApp.window, "documents.save", {
    kind: "invoice",
    partyId: customer.id,
    issueDate: TODAY,
    dueDate: null,
    status: "issued",
    notes: null,
    lines: [
      {
        productId,
        description: "Inline filter",
        quantityMilli: 1_000,
        unitPriceFils: 10_000_000,
        vatTreatment: "zero",
        unitCostFils: 0,
      },
    ],
  });

  const split = await rpc<{
    readonly netProfitFils: number;
    readonly donationRatePercent: number;
    readonly donationFils: number;
    readonly distributableFils: number;
    readonly partners: readonly {
      readonly name: string;
      readonly sharePercent: number;
      readonly amountFils: number;
    }[];
    readonly configurationError: string | null;
  }>(testApp.window, "reports.partnerSplit", { fromDate: TODAY, toDate: TODAY });

  expect(split.configurationError).toBeNull();
  expect(split.netProfitFils).toBe(10_000_000);
  expect(split.donationRatePercent).toBe(2);
  expect(split.donationFils).toBe(200_000);
  expect(split.distributableFils).toBe(9_800_000);

  expect(split.partners.map((partner) => partner.sharePercent)).toEqual([49, 49]);
  expect(split.partners.map((partner) => partner.amountFils)).toEqual([4_900_000, 4_900_000]);

  // 49 + 49 + 2 is the whole profit: nothing is left over and nothing is
  // allocated twice.
  const allocated =
    split.donationFils + split.partners.reduce((sum, partner) => sum + partner.amountFils, 0);
  expect(allocated).toBe(split.netProfitFils);
});

test("Settings shows the split adding up to 100", async () => {
  await testApp.window.getByRole("link", { name: /^settings$/i }).first().click();
  await testApp.window
    .getByRole("navigation", { name: /settings sections/i })
    .getByRole("button", { name: /tax/i })
    .click();

  // The donation and the two partners' shares are shown together, and they
  // come to 100.
  await expect(testApp.window.getByText("The split comes to 100%.")).toBeVisible();
  await expect(testApp.window.getByText(/Donation 2%/)).toBeVisible();
});

test("the finance dashboard shows six summary cards", async () => {
  await navigateTo(testApp.window, /^Finance$/i);
  await testApp.window.getByRole("heading", { name: "Finance overview" }).waitFor({ timeout: 30_000 });

  for (const label of [
    "Cash & Bank Balance",
    "Accounts Receivable",
    "Accounts Payable",
    "Total Income",
    "Total Expenses",
    "Net Profit",
  ]) {
    await expect(testApp.window.getByText(label, { exact: true }).first()).toBeVisible();
  }

  // The cards that used to crowd the page are gone.
  await expect(testApp.window.getByText("Cash in Hand", { exact: true })).toHaveCount(0);
  await expect(testApp.window.getByText("Gross Profit", { exact: true })).toHaveCount(0);
  await expect(testApp.window.getByText("Inventory Asset Value", { exact: true })).toHaveCount(0);
  await expect(testApp.window.getByText("Net Working Capital", { exact: true })).toHaveCount(0);
});
