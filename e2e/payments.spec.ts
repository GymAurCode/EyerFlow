import { expect, test } from "@playwright/test";
import { completeSetup, fillByLabel, launchApp, navigateTo, rpc, type TestApp, todayIso } from "./app";

/**
 * The Update Payment button and the limit on what can be paid.
 *
 * The button is only there when money is still owed, the amount may not
 * exceed what is owed, and the history keeps every payment that was made.
 * These are the rules a shopkeeper can break by accident, so they are driven
 * through the screens rather than through the API.
 */

let testApp: TestApp;

const TODAY = todayIso();

async function seedSupplier(name: string): Promise<number> {
  const created = await rpc<{ id: number }>(testApp.window, "parties.save", {
    kind: "supplier",
    name,
    phone: null,
    email: null,
    trn: null,
    addressLine: null,
  });
  return created.id;
}

async function seedProduct(): Promise<number> {
  const created = await rpc<{ id: number }>(testApp.window, "products.save", {
    name: "Inline filter",
    sku: "FLT-001",
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

/** A purchase of Rs 10,000, issued but not paid. */
async function seedPurchase(supplierId: number, productId: number): Promise<number> {
  const created = await rpc<{ id: number }>(testApp.window, "documents.save", {
    kind: "purchaseInvoice",
    partyId: supplierId,
    issueDate: TODAY,
    dueDate: null,
    status: "issued",
    notes: null,
    lines: [
      {
        productId,
        description: "Inline filter",
        quantityMilli: 10_000,
        unitPriceFils: 100_000,
        vatTreatment: "zero",
        unitCostFils: 100_000,
      },
    ],
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

test("Update payment appears only while a balance is outstanding", async () => {
  const supplierId = await seedSupplier("Gulf Filtration Supplies");
  const productId = await seedProduct();
  await seedPurchase(supplierId, productId);

  await navigateTo(testApp.window, /purchases/i);
  await testApp.window.getByRole("heading", { name: /purchases/i }).first().waitFor({ timeout: 30_000 });

  // Nothing is owed yet? It is: the purchase has just been made. The button is
  // on the row's actions.
  const row = testApp.window.getByRole("row").filter({ hasText: "Gulf Filtration Supplies" }).first();
  await row.waitFor({ timeout: 30_000 });
  await row.getByRole("button").first().click();
  await testApp.window.getByRole("menuitem", { name: /update payment/i }).click();

  const dialog = testApp.window.getByRole("dialog");
  await dialog.waitFor({ timeout: 20_000 });

  // The outstanding is Rs 10,000 and that is all that can be paid.
  await expect(dialog.getByText("Rs 10,000.00").first()).toBeVisible();
  const amount = dialog.getByLabel(/amount/i).first();
  await expect(amount).toHaveValue("10000.00");

  // Pay it all.
  await dialog.getByRole("button", { name: /record payment/i }).click();
  await expect(dialog.getByRole("button", { name: /record payment/i })).toHaveCount(0, {
    timeout: 30_000,
  });

  // The invoice is paid, and the button is gone.
  await testApp.window.waitForTimeout(600);
  const paidRow = testApp.window
    .getByRole("row")
    .filter({ hasText: "Gulf Filtration Supplies" })
    .first();
  await paidRow.getByRole("button").first().click();
  await expect(testApp.window.getByRole("menuitem", { name: /update payment/i })).toHaveCount(0);
});

test("a payment larger than the balance is refused", async () => {
  const supplierId = await seedSupplier("Gulf Filtration Supplies");
  const productId = await seedProduct();
  const purchaseId = await seedPurchase(supplierId, productId);

  // Rs 6,000 of the Rs 10,000 has been paid.
  await rpc(testApp.window, "payments.save", {
    direction: "outbound",
    partyId: supplierId,
    paymentDate: TODAY,
    method: "cash",
    amountFils: 600_000,
    allocations: [{ documentId: purchaseId, amountFils: 600_000 }],
  });

  // The server refuses the extra rupee, whatever the screen says. The date
  // is worked out out here: this callback runs inside the renderer, where the
  // test file's helpers do not exist.
  const paymentDate = todayIso();
  const refused = await testApp.window.evaluate(
    async ([supplier, document, date]) => {
      const api = (
        window as unknown as { api: { invoke: (m: string, p: unknown) => Promise<unknown> } }
      ).api;
      const result = (await api.invoke("payments.save", {
        direction: "outbound",
        partyId: supplier,
        paymentDate: date,
        method: "cash",
        amountFils: 400_100,
        allocations: [{ documentId: document, amountFils: 400_100 }],
      })) as { ok: boolean; error?: { message: string } };
      return result.ok ? "" : (result.error?.message ?? "");
    },
    [supplierId, purchaseId, paymentDate] as [number, number, string],
  );
  expect(refused).toMatch(/Payment cannot exceed the outstanding balance of Rs 4,000\.00\./);

  // And the payment history is untouched: one payment, and the invoice still
  // owes exactly Rs 4,000.
  const payments = await rpc<readonly { amountFils: number }[]>(testApp.window, "payments.list", {
    partyId: supplierId,
  });
  expect(payments).toHaveLength(1);
  expect(payments[0]?.amountFils).toBe(600_000);

  const document = await rpc<{ outstandingFils: number; status: string }>(
    testApp.window,
    "documents.get",
    { id: purchaseId },
  );
  expect(document.outstandingFils).toBe(400_000);
  expect(document.status).toBe("partPaid");
});

test("the dialog refuses an amount over the balance and accepts the rest", async () => {
  const supplierId = await seedSupplier("Gulf Filtration Supplies");
  const productId = await seedProduct();
  const purchaseId = await seedPurchase(supplierId, productId);

  await rpc(testApp.window, "payments.save", {
    direction: "outbound",
    partyId: supplierId,
    paymentDate: TODAY,
    method: "cash",
    amountFils: 600_000,
    allocations: [{ documentId: purchaseId, amountFils: 600_000 }],
  });

  await navigateTo(testApp.window, /purchases/i);
  const row = testApp.window.getByRole("row").filter({ hasText: "Gulf Filtration Supplies" }).first();
  await row.waitFor({ timeout: 30_000 });
  await row.getByRole("button").first().click();
  await testApp.window.getByRole("menuitem", { name: /update payment/i }).click();

  const dialog = testApp.window.getByRole("dialog");
  await dialog.waitFor({ timeout: 20_000 });

  // Rs 4,001 is one rupee too much.
  await fillByLabel(testApp.window, /amount/i, "4001");
  await dialog.getByRole("button", { name: /record payment/i }).click();
  await expect(dialog.getByText(/cannot exceed the outstanding balance/i)).toBeVisible();

  // Rs 4,000 is exactly what is owed.
  await fillByLabel(testApp.window, /amount/i, "4000");
  await dialog.getByRole("button", { name: /record payment/i }).click();
  await expect(dialog.getByRole("button", { name: /record payment/i })).toHaveCount(0, {
    timeout: 30_000,
  });

  const document = await rpc<{ outstandingFils: number; status: string }>(
    testApp.window,
    "documents.get",
    { id: purchaseId },
  );
  expect(document.outstandingFils).toBe(0);
  expect(document.status).toBe("paid");

  // Two payments, and both are still on the record.
  const payments = await rpc<readonly { amountFils: number }[]>(testApp.window, "payments.list", {
    partyId: supplierId,
  });
  expect(payments).toHaveLength(2);

  // And the document shows its payment history.
  const history = await rpc<readonly { amountFils: number }[]>(testApp.window, "payments.list", {
    documentId: purchaseId,
  });
  expect(history).toHaveLength(2);
  expect(history.map((payment) => payment.amountFils).sort()).toEqual([400_000, 600_000]);
});

test("the interface offers no currency but Pakistani Rupees", async () => {
  await navigateTo(testApp.window, /settings/i).catch(() => {
    /* the settings link is on the shell; the helper below opens it directly */
  });

  await testApp.window.getByRole("link", { name: /^settings$/i }).first().click();
  await testApp.window
    .getByRole("navigation", { name: /settings sections/i })
    .getByRole("button", { name: /company/i })
    .click();

  // The currency is a fact about the shop, not a choice: it is shown, and it
  // says PKR.
  await expect(testApp.window.getByLabel(/currency/i).first()).toHaveValue("PKR");

  // Nowhere on the screen is there a choice of AED or USD.
  const body = await testApp.window.locator("body").innerText();
  expect(body).not.toMatch(/\bAED\b/);
  expect(body).not.toMatch(/\bUSD\b/);
});
