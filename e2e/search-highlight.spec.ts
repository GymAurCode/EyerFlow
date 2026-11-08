import { expect, test } from "@playwright/test";
import { completeSetup, launchApp, rpc, type TestApp, todayIso } from "./app";

/**
 * Search-result highlighting, driven through the real screens.
 *
 * The unit tests prove the matching rules; these tests prove the parts a rule
 * cannot: that the rows the server returned are the rows that light up, that
 * the best match is brought to the reader even when it is on another page, that
 * the marks sit inside the text, that clearing the search leaves no residue,
 * and that the tint is still visible in both colour modes.
 *
 * The seeded lists are deliberately longer than one page (25 rows) so the
 * pagination jump is exercised rather than inferred.
 */

let testApp: TestApp;

const TODAY = todayIso();

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

async function seedProduct(
  name: string,
  sku: string,
  openingQuantityMilli = 0,
): Promise<number> {
  const created = await rpc<{ id: number }>(testApp.window, "products.save", {
    name,
    nameAr: null,
    sku,
    barcode: null,
    description: null,
    category: "Filters",
    reorderLevelMilli: 2_000,
    salePriceFils: 7_500,
    vatTreatment: "zero",
    isSerialised: false,
    isService: false,
    warrantyMonths: 12,
    openingQuantityMilli,
  });
  return created.id;
}

async function seedInvoice(
  customerId: number,
  productId: number,
  description: string,
): Promise<{ id: number; number: string }> {
  return rpc<{ id: number; number: string }>(testApp.window, "documents.save", {
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
        description,
        quantityMilli: 1_000,
        unitPriceFils: 7_500,
        vatTreatment: "zero",
        unitCostFils: 4_000,
      },
    ],
  });
}

async function seedPurchase(
  supplierId: number,
  productId: number,
  description: string,
): Promise<{ id: number; number: string }> {
  return rpc<{ id: number; number: string }>(testApp.window, "documents.save", {
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
        description,
        quantityMilli: 10_000,
        unitPriceFils: 4_000,
        vatTreatment: "zero",
        unitCostFils: 4_000,
      },
    ],
  });
}

async function navigate(link: RegExp): Promise<void> {
  await testApp.window.getByRole("link", { name: link }).first().click();
  await testApp.window.waitForTimeout(400);
}

async function seedJournal(description: string): Promise<void> {
  await rpc(testApp.window, "finance.journal.save", {
    entryDate: TODAY,
    description,
    reference: null,
    postNow: true,
    lines: [
      { accountCode: "1000", debitFils: 100, creditFils: 0, description: null },
      { accountCode: "4000", debitFils: 0, creditFils: 100, description: null },
    ],
  });
}

async function setTheme(theme: "Light" | "Dark"): Promise<void> {
  await testApp.window.getByRole("button", { name: /^Theme:/ }).click();
  await testApp.window.getByRole("menuitemradio", { name: new RegExp(`^${theme}$`) }).click();
  await expect
    .poll(() =>
      testApp.window.evaluate(
        (next) => document.documentElement.classList.contains("dark") === (next === "Dark"),
        theme,
      ),
    )
    .toBe(true);
}

/** The resolved highlight colours, after the short tint animation has settled. */
async function highlightColours(): Promise<{ readonly row: string; readonly mark: string }> {
  await testApp.window.waitForTimeout(300);
  return testApp.window.getByRole("table").evaluate((table) => {
    const row =
      table.querySelector<HTMLElement>('tr[data-highlight="primary"]') ??
      table.querySelector<HTMLElement>('tr[data-highlight="match"]');
    const mark = table.querySelector<HTMLElement>("mark.search-match");
    return {
      row: row === null ? "" : getComputedStyle(row).backgroundColor,
      mark: mark === null ? "" : getComputedStyle(mark).backgroundColor,
    };
  });
}

test.beforeEach(async () => {
  testApp = await launchApp();
  await completeSetup(testApp.window);
});

test.afterEach(async () => {
  await testApp?.close();
});

test("a product search marks every match and opens the page holding the best one", async () => {
  // Twenty-nine names contain "Filter" and sort before the exact name, so the
  // best match is on the second page. It is the exact value, which is the
  // strongest tier the matcher has.
  for (let index = 1; index <= 29; index += 1) {
    const suffix = String(index).padStart(2, "0");
    await seedProduct(`A Filter ${suffix}`, `AFLT-${suffix}`);
  }
  await seedProduct("Filter", "FLT-EXACT");

  await navigate(/^products$/i);

  const table = testApp.window.getByRole("table");
  await expect(table).toBeVisible();

  const search = testApp.window.getByPlaceholder(/name, category or code/i);
  await search.fill("Filter");

  const primary = table.locator('tr[data-highlight="primary"]');
  await expect(primary).toBeVisible();
  await expect(primary).toContainText("Filter");
  await expect(primary.locator("mark.search-match")).toHaveText("Filter");

  // The best match is page 2, and the page moved there by itself.
  await expect(testApp.window.getByRole("button", { name: "Page 2" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  // The five rows on the second page are all genuine matches and all marked.
  await expect(table.locator("tbody tr[data-highlight]")).toHaveCount(5);
  await expect(table.locator("mark.search-match")).toHaveCount(5);

  const light = await highlightColours();
  expect(light.row).not.toBe("");
  expect(light.row).not.toBe("rgba(0, 0, 0, 0)");
  expect(light.mark).not.toBe("");
  expect(light.mark).not.toBe("rgba(0, 0, 0, 0)");

  await setTheme("Dark");
  await expect(primary).toBeVisible();
  await expect(primary.locator("mark.search-match")).toBeVisible();

  const dark = await highlightColours();
  expect(dark.row).not.toBe("rgba(0, 0, 0, 0)");
  expect(dark.mark).not.toBe("rgba(0, 0, 0, 0)");
  // The tint is derived from the live accent, so the two modes do not paint
  // the same colour.
  expect(dark.row).not.toBe(light.row);

  await search.fill("");
  await expect(table.locator("tr[data-highlight]")).toHaveCount(0);
  await expect(table.locator("mark.search-match")).toHaveCount(0);
});

test("invoice and purchase searches highlight, page, clear, and keep working in the dark", async () => {
  const supplierId = await seedParty("supplier", "Gulf Filtration Supplies");
  const customerId = await seedParty("customer", "Sunrise Villa Complex");
  const productId = await seedProduct("Inline filter", "FLT-001", 1_000_000);

  for (let index = 1; index <= 30; index += 1) {
    await seedInvoice(customerId, productId, `Inline filter ${String(index)}`);
  }
  await seedPurchase(supplierId, productId, "Inline filter stock");

  await navigate(/^sales$/i);

  const table = testApp.window.getByRole("table");
  await expect(table).toBeVisible();

  const search = testApp.window.getByPlaceholder(/number or party name/i);
  await search.fill("Sunrise");

  // Every invoice belongs to the customer, so every visible row is a match.
  await expect(table.locator('tr[data-highlight="primary"]')).toHaveCount(1);
  await expect(table.locator("tbody tr[data-highlight]")).toHaveCount(25);
  await expect(table.locator("mark.search-match")).toHaveCount(25);
  await expect(table.locator('tr[data-highlight="primary"] mark.search-match')).toHaveText(
    "Sunrise",
  );

  const light = await highlightColours();
  expect(light.row).not.toBe("rgba(0, 0, 0, 0)");
  expect(light.mark).not.toBe("rgba(0, 0, 0, 0)");

  // The second page keeps the highlight; the primary is on page 1.
  await testApp.window.getByRole("button", { name: "Next page" }).click();
  await expect(table.locator("tbody tr[data-highlight]")).toHaveCount(5);
  await expect(table.locator("mark.search-match")).toHaveCount(5);
  await expect(table.locator('tr[data-highlight="primary"]')).toHaveCount(0);

  await setTheme("Dark");
  await expect(table.locator("mark.search-match").first()).toBeVisible();
  const dark = await highlightColours();
  expect(dark.row).not.toBe("rgba(0, 0, 0, 0)");
  expect(dark.mark).not.toBe("rgba(0, 0, 0, 0)");
  expect(dark.row).not.toBe(light.row);

  await search.fill("");
  await expect(table.locator("tr[data-highlight]")).toHaveCount(0);
  await expect(table.locator("mark.search-match")).toHaveCount(0);

  // Purchases are the same table read from the other side, so its search has
  // to behave the same way.
  await navigate(/^purchases$/i);
  const purchaseTable = testApp.window.getByRole("table");
  await expect(purchaseTable).toBeVisible();
  const purchaseSearch = testApp.window.getByPlaceholder(/number or party name/i);
  await purchaseSearch.fill("Gulf");

  await expect(purchaseTable.locator("tbody tr[data-highlight]")).toHaveCount(1);
  await expect(purchaseTable.locator("tr[data-highlight] mark.search-match").first()).toHaveText(
    "Gulf",
  );

  await purchaseSearch.fill("");
  await expect(purchaseTable.locator("tr[data-highlight]")).toHaveCount(0);
  await expect(purchaseTable.locator("mark.search-match")).toHaveCount(0);
});

test("a virtualised list scrolls to a best match far outside the rendered window", async () => {
  // The exact description is written first, so the newest-first journal puts
  // it last: 159 matching rows sit between the top of the list and the best
  // match. That is well past the 150-row virtualisation threshold, so the row
  // is not in the DOM until the table scrolls to it.
  await seedJournal("Scroll");
  for (let index = 1; index <= 159; index += 1) {
    await seedJournal(`A Scroll Entry ${String(index).padStart(3, "0")}`);
  }

  await navigate(/^finance$/i);
  await testApp.window.getByRole("link", { name: /^Journal Entries$/i }).click();

  const table = testApp.window.getByRole("table");
  await expect(table).toBeVisible();

  await testApp.window.getByPlaceholder("Number, description or reference").fill("Scroll");

  const primary = table.locator('tr[data-highlight="primary"]');
  await expect(primary).toBeVisible();
  await expect(primary.locator("mark.search-match")).toHaveText("Scroll");

  // The container itself moved, rather than the page jumping to the end.
  const scrollTop = await table.evaluate((element) => {
    const container = element.parentElement;
    return container === null ? 0 : container.scrollTop;
  });
  expect(scrollTop).toBeGreaterThan(0);

  // Every rendered match is marked; the virtualiser only paints a window, so
  // the assertion is that the window holds highlights rather than all 160.
  expect(await table.locator("tbody tr[data-highlight]").count()).toBeGreaterThan(0);
  expect(await table.locator("mark.search-match").count()).toBeGreaterThan(0);

  await testApp.window.getByPlaceholder("Number, description or reference").fill("");
  await expect(table.locator("tr[data-highlight]")).toHaveCount(0);
  await expect(table.locator("mark.search-match")).toHaveCount(0);

  // The account ledger paginates by hand and keeps its own page state. A new
  // group of rows contains "Ledger Move", and the exact description is written
  // last, so it is the final row in ascending ledger order; the matcher has to
  // take the reader to the last page rather than leaving them on page 1.
  for (let index = 1; index <= 30; index += 1) {
    await seedJournal(`A Ledger Move ${String(index).padStart(2, "0")}`);
  }
  await seedJournal("Ledger Move");

  await navigate(/^finance$/i);
  await testApp.window.getByRole("link", { name: /^Chart of Accounts$/i }).click();
  const accountButton = testApp.window.getByRole("button", { name: /^1000 Cash in Hand$/ });
  await expect(accountButton).toBeVisible();
  await accountButton.click();
  await testApp.window.getByRole("tab", { name: "Transaction History" }).click();

  const ledgerTable = testApp.window.getByRole("table");
  await expect(ledgerTable).toBeVisible();
  await testApp.window.getByPlaceholder("Search transactions").fill("Ledger Move");

  const ledgerPrimary = ledgerTable.locator('tr[data-highlight="primary"]');
  await expect(ledgerPrimary).toBeVisible();
  await expect(ledgerPrimary.locator("mark.search-match")).toHaveText("Ledger Move");
  // The exact match is the last row of the ledger, so the manual pager is on
  // its final page and there is nowhere further to go.
  await expect(testApp.window.getByRole("button", { name: "Next page" })).toBeDisabled();
});

test("journal, payments and receivables searches mark the rows they matched", async () => {
  const supplierId = await seedParty("supplier", "Gulf Filtration Supplies");
  const customerId = await seedParty("customer", "Sunrise Villa Complex");
  const productId = await seedProduct("Inline filter", "FLT-001", 1_000_000);

  const invoice = await seedInvoice(customerId, productId, "Inline filter");
  await seedPurchase(supplierId, productId, "Inline filter stock");

  await rpc(testApp.window, "payments.save", {
    direction: "inbound",
    partyId: customerId,
    paymentDate: TODAY,
    method: "cash",
    amountFils: 1_000,
    reference: "RCP-SEARCH-1",
    notes: null,
    allocations: [{ documentId: invoice.id, amountFils: 1_000 }],
  });

  await navigate(/^finance$/i);

  // The journal's description carries the invoice number, so both the sale and
  // its cost-of-goods entry are genuine matches.
  await testApp.window.getByRole("link", { name: /^Journal Entries$/i }).click();
  const journalTable = testApp.window.getByRole("table");
  await expect(journalTable).toBeVisible();
  const journalSearch = testApp.window.getByPlaceholder("Number, description or reference");
  await journalSearch.fill(invoice.number);

  await expect
    .poll(async () => journalTable.locator("tbody tr[data-highlight]").count())
    .toBeGreaterThan(0);
  await expect(journalTable.locator('tr[data-highlight="primary"]')).toHaveCount(1);
  await expect(journalTable.locator("mark.search-match").first()).toHaveText(invoice.number);

  await journalSearch.fill("");
  await expect(journalTable.locator("tr[data-highlight]")).toHaveCount(0);
  await expect(journalTable.locator("mark.search-match")).toHaveCount(0);

  // Payments are filtered in the renderer: the repository has no search
  // parameter, so this proves the client-side field list reaches the row.
  await testApp.window.getByRole("link", { name: /^Payments & Receipts$/i }).click();
  const paymentTable = testApp.window.getByRole("table");
  await expect(paymentTable).toBeVisible();
  await testApp.window.getByPlaceholder("Reference or amount").fill("RCP-SEARCH-1");

  await expect(paymentTable.locator("tbody tr[data-highlight]")).toHaveCount(1);
  await expect(paymentTable.locator("tr[data-highlight] mark.search-match").first()).toHaveText(
    "RCP-SEARCH-1",
  );

  // Receivables filter in the renderer too, by party name.
  await testApp.window.getByRole("link", { name: /^Customer Receivables$/i }).click();
  const receivableTable = testApp.window.getByRole("table");
  await expect(receivableTable).toBeVisible();
  await testApp.window.getByPlaceholder("Name", { exact: true }).fill("Sunrise");

  await expect(receivableTable.locator("tbody tr[data-highlight]")).toHaveCount(1);
  await expect(
    receivableTable.locator("tr[data-highlight] mark.search-match").first(),
  ).toHaveText("Sunrise");
});
