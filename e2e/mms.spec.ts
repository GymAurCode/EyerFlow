import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { completeSetup, launchApp, rpc, todayIso, type TestApp } from "./app";

/**
 * Manufacturing, end to end, in the application a user runs.
 *
 * The two things worth protecting are the ones a unit test cannot see: that the
 * module is reachable from the rail at all, and that producing something moves
 * the same IMS stock ledger the rest of the app reads. The second is asserted
 * by producing a finished good from raw material and then reading both products
 * back through the ordinary IMS product API.
 */

let testApp: TestApp;
const TODAY = todayIso();

async function seedProduct(name: string, sku: string): Promise<number> {
  const created = await rpc<{ id: number }>(testApp.window, "products.save", {
    name,
    nameAr: null,
    sku,
    barcode: null,
    description: null,
    category: "Manufacturing",
    reorderLevelMilli: 0,
    salePriceFils: 15_000,
    vatTreatment: "standard",
    isSerialised: false,
    isService: false,
    warrantyMonths: 12,
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

test("MMS is in the sidebar and every manufacturing screen opens", async () => {
  const page = testApp.window;
  const rail = page.getByRole("complementary", { name: "Main navigation" });

  // The module row itself, then the groups inside it. The groups were wired to
  // a no-op before, so the pages behind them were unreachable.
  await rail.getByRole("button", { name: /manufacturing/i }).click();
  await rail.getByRole("link", { name: "Production Dashboard" }).waitFor({ timeout: 15_000 });

  await rail.getByRole("button", { name: /production operations/i }).click();
  await rail.getByRole("link", { name: /manufacturing orders/i }).click();
  await expect(page).toHaveURL(/#\/mms\/production\/orders$/);
  // `.last()`: the top bar carries the same title as a screen-reader heading.
  await expect(page.getByRole("heading", { name: "Manufacturing Orders" }).last()).toBeVisible();

  await rail.getByRole("link", { name: /work orders/i }).click();
  await expect(page).toHaveURL(/#\/mms\/work-orders$/);

  await rail.getByRole("button", { name: /engineering/i }).click();
  await rail.getByRole("link", { name: /bills of materials/i }).click();
  await expect(page).toHaveURL(/#\/mms\/boms$/);
  await expect(page.getByRole("heading", { name: "Bills of Materials" }).last()).toBeVisible();

  // A screen that had no route at all before: it used to redirect to `/`.
  await rail.getByRole("button", { name: /production control/i }).click();
  await rail.getByRole("link", { name: /work in progress/i }).click();
  await expect(page).toHaveURL(/#\/mms\/wip$/);
  await expect(page.getByRole("heading", { name: "Work in Progress" }).last()).toBeVisible();
});

test("a BOM, order, work order, consumption and receipt produce IMS stock", async () => {
  const supplier = await rpc<{ id: number }>(testApp.window, "parties.save", {
    kind: "supplier",
    name: "Gulf Plastics",
    phone: null,
    email: null,
    trn: null,
    addressLine: null,
    emirate: null,
  });

  const rawId = await seedProduct("Filter housing", "RAW-001");
  const finishedId = await seedProduct("Inline filter", "FIN-001");

  // 100 housings in stock, so releasing the order has material to reserve.
  await rpc(testApp.window, "documents.save", {
    kind: "purchaseInvoice",
    partyId: supplier.id,
    issueDate: TODAY,
    dueDate: null,
    status: "issued",
    notes: null,
    reason: null,
    lines: [
      {
        productId: rawId,
        description: "Filter housing",
        quantityMilli: 100_000,
        unitPriceFils: 4_000,
        vatTreatment: "standard",
        unitCostFils: 4_000,
      },
    ],
  });

  // A routing, so releasing the order creates a work order to complete.
  const route = await rpc<{ id: number }>(testApp.window, "mms.routes.save", {
    name: "Filter assembly",
    status: "approved",
    effectiveFrom: TODAY,
  });
  await rpc(testApp.window, "mms.routeOperations.save", {
    routeId: route.id,
    operationCode: "OP-10",
    name: "Assemble filter",
    sequence: 1,
    cycleTimeMinutes: 5,
  });

  const bom = await rpc<{ id: number; number: string }>(testApp.window, "mms.boms.save", {
    productId: finishedId,
    name: "Inline filter BOM",
    bomType: "assembly",
    baseOutputQuantity: 1000,
    outputUnit: "pcs",
    routingId: route.id,
  });
  expect(bom.number).toMatch(/^BOM-/);

  await rpc(testApp.window, "mms.bomComponents.save", {
    bomId: bom.id,
    componentProductId: rawId,
    quantityPerUnit: 1000,
    unit: "pcs",
  });

  const approved = await rpc<{ status: string; components: readonly unknown[] }>(
    testApp.window,
    "mms.boms.approve",
    { id: bom.id },
  );
  expect(approved.status).toBe("approved");
  expect(approved.components).toHaveLength(1);

  const order = await rpc<{ id: number; number: string; status: string }>(
    testApp.window,
    "mms.orders.save",
    {
      productId: finishedId,
      bomId: bom.id,
      plannedQuantity: 10_000,
      routeId: route.id,
    },
  );
  expect(order.number).toMatch(/^MO-/);
  expect(order.status).toBe("planned");

  const released = await rpc<{ status: string; components: readonly { requiredQuantity: number }[] }>(
    testApp.window,
    "mms.orders.release",
    { id: order.id },
  );
  expect(released.status).toBe("released");
  expect(released.components[0]?.requiredQuantity).toBe(10_000);

  const workOrders = await rpc<readonly { id: number; status: string }[]>(
    testApp.window,
    "mms.workOrders.list",
    { moId: order.id },
  );
  expect(workOrders).toHaveLength(1);
  expect(workOrders[0]?.status).toBe("ready");

  // Move the material: available -> WIP -> consumed.
  await rpc(testApp.window, "mms.materialIssues.issueToWip", {
    moId: order.id,
    componentProductId: rawId,
    quantityMilli: 10_000,
  });
  await rpc(testApp.window, "mms.materialIssues.consume", {
    moId: order.id,
    componentProductId: rawId,
    quantityMilli: 10_000,
  });

  const workOrderId = workOrders[0]?.id ?? 0;
  await rpc(testApp.window, "mms.workOrders.start", { id: workOrderId });
  await rpc(testApp.window, "mms.workOrders.complete", {
    id: workOrderId,
    actualQuantity: 10_000,
    acceptedQuantity: 10_000,
    rejectedQuantity: 0,
  });

  // Completing the operation must roll up into the order, or no receipt can
  // ever be accepted. This is the assertion the old code failed.
  const producing = await rpc<{ status: string; actualQuantity: number }>(
    testApp.window,
    "mms.orders.get",
    { id: order.id },
  );
  expect(producing.status).toBe("qualityReview");
  expect(producing.actualQuantity).toBe(10_000);

  // QC must pass before finished goods can be received.
  await rpc(testApp.window, "mms.qualityChecks.save", {
    moId: order.id,
    checkpoint: "Final inspection",
    inspectionType: "passFail",
    result: "passed",
  });

  const receipt = await rpc<{ quantityMilli: number; acceptedQty: number }>(
    testApp.window,
    "mms.finishedReceipts.save",
    { moId: order.id, quantityMilli: 10_000 },
  );
  expect(receipt.acceptedQty).toBe(10_000);

  // The finished product is now in IMS stock, and the raw material is down by
  // exactly what was consumed - one ledger, read back through the IMS API.
  const finished = await rpc<{ quantityMilli: number }>(testApp.window, "products.get", {
    id: finishedId,
  });
  expect(finished.quantityMilli).toBe(10_000);

  const raw = await rpc<{ quantityMilli: number }>(testApp.window, "products.get", { id: rawId });
  expect(raw.quantityMilli).toBe(90_000);

  const dashboard = await rpc<{ totalMo: number; producedUnits: number }>(testApp.window, "mms.dashboard", {});
  expect(dashboard.totalMo).toBe(1);
  expect(dashboard.producedUnits).toBe(10_000);
  const page = testApp.window;
  await page.evaluate(() => { location.hash = "/mms"; });
  await expect(page.getByText("Total Manufacturing Orders", { exact: true })).toBeVisible();
  await expect(page.getByText("The dashboard could not load", { exact: true })).toHaveCount(0);
  mkdirSync("docs/mms-parity", { recursive: true });
  await page.screenshot({ path: "docs/mms-parity/dashboard-populated.png", fullPage: true });
  await page.evaluate(() => { location.hash = "/mms/boms"; });
  const search = page.getByRole("textbox", { name: "Search records", exact: true });
  await search.fill("no-such-bom");
  await expect(page.getByText("No matching records", { exact: true })).toBeVisible();
  await search.fill(bom.number);
  await expect(page.getByRole("cell", { name: bom.number, exact: true })).toBeVisible();
  await page.getByRole("columnheader", { name: "BOM No" }).click();
  await expect(page.getByRole("columnheader", { name: "BOM No" })).toHaveAttribute("aria-sort", "ascending");
  await page.screenshot({ path: "docs/mms-parity/boms-populated.png", fullPage: true });
  await page.getByRole("button", { name: "Open BOM", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#/mms/boms/${bom.id}$`));
});

test("the BOM and manufacturing order pages open from the rail", async () => {
  const page = testApp.window;
  const rail = page.getByRole("complementary", { name: "Main navigation" });

  await rail.getByRole("button", { name: /manufacturing/i }).click();
  await rail.getByRole("button", { name: /production operations/i }).click();
  await rail.getByRole("link", { name: /manufacturing orders/i }).click();
  await expect(page.getByRole("heading", { name: "Manufacturing Orders" }).last()).toBeVisible();

  // The "New MO" dialog is a real form now, not an empty shell.
  await page.getByRole("button", { name: /new mo/i }).click();
  await expect(page.getByRole("dialog")).toContainText(/approved bom/i);
  await page.getByRole("button", { name: /^cancel$/i }).click();

  await rail.getByRole("button", { name: /engineering/i }).click();
  await rail.getByRole("link", { name: /bills of materials/i }).click();
  await page.getByRole("button", { name: /new bom/i }).click();
  await expect(page.getByRole("dialog")).toContainText(/create bom/i);
});
