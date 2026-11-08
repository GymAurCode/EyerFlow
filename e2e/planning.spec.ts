import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import {
  completeSetup,
  launchApp,
  rpc,
  todayIso,
  createTestDataDir,
  removeTestDataDir,
  signIn,
  type TestApp,
} from "./app";
import type { MpsPlanDto, MrpRunDto } from "../src/shared/mms";
import type { ImsDocumentDto } from "../src/shared/ims";
let app: TestApp;
let dir: string;
const errors: string[] = [];
test.beforeEach(async () => {
  dir = createTestDataDir();
  app = await launchApp(dir);
  errors.length = 0;
  app.window.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await app.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(1920, 1080);
  });
  await completeSetup(app.window);
  mkdirSync("docs/planning", { recursive: true });
});
test.afterEach(async () => {
  await app?.close();
  removeTestDataDir(dir);
});
async function item(name: string, qty = 0) {
  return (
    await rpc<{ id: number }>(app.window, "products.save", {
      name,
      sku: name,
      unit: "pcs",
      openingQuantityMilli: qty,
      vatTreatment: "standard",
    })
  ).id;
}
async function bom(parent: number, name: string, parts: { id: number; qty: number }[]) {
  const b = await rpc<{ id: number }>(app.window, "mms.boms.save", {
    productId: parent,
    name,
    baseOutputQuantity: 1000,
    outputUnit: "pcs",
    effectiveFrom: todayIso(),
  });
  for (const [i, p] of parts.entries())
    await rpc(app.window, "mms.bomComponents.save", {
      bomId: b.id,
      componentProductId: p.id,
      quantityPerUnit: p.qty,
      unit: "pcs",
      lineNo: i + 1,
    });
  await rpc(app.window, "mms.boms.approve", { id: b.id });
  return b.id;
}
async function select(page: Page, label: string, value: string) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: value, exact: true }).click();
}
async function goto(path: string) {
  await app.window.evaluate((p) => {
    location.hash = p;
  }, path);
}
async function runMrp() {
  await goto("/mms/planning/mrp");
  await app.window.getByRole("button", { name: "Run MRP", exact: true }).first().click();
  await app.window.getByRole("button", { name: "Calculate MRP", exact: true }).click();
  await expect(app.window.getByRole("dialog")).toHaveCount(0);
}

test("MPS form calculates 90 tables, edits, approves, persists and generates an MO once", async () => {
  const fg = await item("Tables", 20_000),
    legs = await item("Legs");
  await bom(fg, "Table BOM", [{ id: legs, qty: 4000 }]);
  const page = app.window;
  await goto("/mms/planning/mps");
  await page.getByRole("button", { name: "Create Production Schedule", exact: true }).click();
  await select(page, "Product", "Tables");
  await select(page, "Approved BOM", "Table BOM");
  await select(page, "Planning Horizon", "Daily");
  await page.getByLabel("Period Start", { exact: true }).fill(todayIso());
  await page.getByLabel("Period End", { exact: true }).fill(todayIso());
  await page.getByLabel("Forecast Demand", { exact: true }).fill("100");
  await page.getByLabel("Confirmed Demand", { exact: true }).fill("100");
  await page.getByLabel("Safety Stock", { exact: true }).fill("10");
  await page.getByLabel("Forecast Demand", { exact: true }).fill("-1");
  await page.getByRole("button", { name: "Save Draft Plan", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("Reference:");
  expect(await rpc<MpsPlanDto[]>(page, "mms.mps.plans.list")).toEqual([]);
  await page.screenshot({ path: "docs/planning/mps-validation-error.png", fullPage: true });
  await page.getByLabel("Forecast Demand", { exact: true }).fill("100");
  await page.getByRole("button", { name: "Save Draft Plan", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.locator("table").first().getByRole("cell", { name: "90", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByLabel("Confirmed Demand", { exact: true }).fill("90");
  await page.getByRole("button", { name: "Save Draft Plan", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Approve Plan", exact: true }).click();
  await page.getByRole("button", { name: "Generate Manufacturing Orders", exact: true }).click();
  await expect(
    page.locator("table").first().getByRole("cell", { name: "converted", exact: true }),
  ).toBeVisible();
  const plans = await rpc<MpsPlanDto[]>(page, "mms.mps.plans.list");
  expect(plans[0]?.recommendedProduction).toBe(90_000);
  expect(plans[0]?.buckets[0]?.generatedMoId).toBeGreaterThan(0);
  await rpc(page, "mms.mps.generateOrders", { id: plans[0]!.id });
  const orders = await rpc<{ plannedQuantity: number }[]>(page, "mms.orders.list");
  expect(orders).toHaveLength(1);
  expect(orders[0]!.plannedQuantity).toBe(90_000);
  await page
    .locator("table")
    .first()
    .evaluate((table) => {
      table.parentElement!.scrollLeft = 0;
    });
  await page.screenshot({ path: "docs/planning/mps-working.png", fullPage: true });
  await page.getByRole("button", { name: /Theme: .*Change theme/ }).click();
  await page.getByRole("menuitemradio", { name: "Dark", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.screenshot({ path: "docs/planning/mps-dark.png", fullPage: true });
  await page.getByRole("button", { name: /Theme: .*Change theme/ }).click();
  await page.getByRole("menuitemradio", { name: "Light", exact: true }).click();
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("generateOrders");
  await page.screenshot({ path: "docs/planning/mps-history.png", fullPage: true });
  expect(errors).toEqual([]);
  await app.close();
  app = await launchApp(dir);
  await app.window.waitForLoadState("domcontentloaded");
  if (await app.window.getByRole("button", { name: /^sign in$/i }).isVisible())
    await signIn(app.window);
  await app.window.getByRole("navigation").first().waitFor();
  await goto("/mms/planning/mps");
  await expect(
    app.window.locator("table").first().getByRole("cell", { name: "converted", exact: true }),
  ).toBeVisible();
});

test("MRP UI calculates shortages and generates traceable real IMS requisitions", async () => {
  const fg = await item("Tables"),
    legs = await item("Legs", 250_000),
    tops = await item("Tabletops", 100_000),
    screws = await item("Screws", 500_000);
  const bid = await bom(fg, "Table BOM", [
    { id: legs, qty: 4000 },
    { id: tops, qty: 1000 },
    { id: screws, qty: 8000 },
  ]);
  await rpc(app.window, "mms.orders.save", {
    productId: fg,
    bomId: bid,
    plannedQuantity: 100_000,
    plannedStart: todayIso(),
    plannedFinish: todayIso(),
  });
  await runMrp();
  const page = app.window;
  const legRow = page.getByRole("row").filter({ hasText: "Legs (Legs)" });
  await expect(legRow.getByRole("cell", { name: "400", exact: true })).toBeVisible();
  await expect(legRow.getByRole("cell", { name: "150", exact: true }).first()).toBeVisible();
  const runs = await rpc<MrpRunDto[]>(page, "mms.mrp.runs.list");
  expect(runs[0]!.requirements.find((r) => r.productId === screws)?.shortageQty).toBe(300_000);
  expect(runs[0]!.requirements.find((r) => r.productId === tops)?.shortageQty).toBe(0);
  await page.getByRole("button", { name: "Approve MRP Run", exact: true }).click();
  await page
    .getByRole("button", { name: "Generate IMS Purchase Requisitions", exact: true })
    .click();
  await expect(page.getByRole("button", { name: /View requisition/ })).toHaveCount(2);
  await page.screenshot({ path: "docs/planning/mrp-working.png", fullPage: true });
  await page.getByRole("button", { name: /Theme: .*Change theme/ }).click();
  await page.getByRole("menuitemradio", { name: "Dark", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.screenshot({ path: "docs/planning/mrp-dark.png", fullPage: true });
  await page.getByRole("button", { name: /Theme: .*Change theme/ }).click();
  await page.getByRole("menuitemradio", { name: "Light", exact: true }).click();
  await page
    .getByRole("button", { name: /View requisition/ })
    .first()
    .click();
  await expect(page.getByRole("dialog")).toContainText("MRP:");
  await page.screenshot({ path: "docs/planning/ims-requisition.png", fullPage: true });
  const prs = await rpc<ImsDocumentDto[]>(page, "ims.documents.list", {
    kind: "purchaseRequisition",
  });
  expect(prs).toHaveLength(2);
  expect(prs.flatMap((p) => p.lines.map((l) => l.quantityMilli)).sort((a, b) => a - b)).toEqual([
    150_000, 300_000,
  ]);
  await rpc(page, "mms.mrp.generateRequisitions", { id: runs[0]!.id });
  expect(
    await rpc<unknown[]>(page, "ims.documents.list", { kind: "purchaseRequisition" }),
  ).toHaveLength(2);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "MRP Run History", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("approved");
  await page.screenshot({ path: "docs/planning/mrp-history.png", fullPage: true });
  await page.getByRole("button", { name: "View Run", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("MRP UI generates a multi-level subassembly MO and preserves its component demand", async () => {
  const fg = await item("Tables"),
    frame = await item("Frames"),
    bolts = await item("Bolts");
  await bom(frame, "Frame BOM", [{ id: bolts, qty: 2000 }]);
  const bid = await bom(fg, "Table BOM", [{ id: frame, qty: 1000 }]);
  await rpc(app.window, "mms.orders.save", {
    productId: fg,
    bomId: bid,
    plannedQuantity: 10_000,
    plannedStart: todayIso(),
    plannedFinish: todayIso(),
  });
  await runMrp();
  const page = app.window;
  await page.getByRole("button", { name: "Approve MRP Run", exact: true }).click();
  await page
    .getByRole("button", { name: "Generate Subassembly Manufacturing Orders", exact: true })
    .click();
  await expect(page.getByRole("button", { name: /View MO #/ })).toHaveCount(1);
  await page
    .getByRole("button", { name: "Generate IMS Purchase Requisitions", exact: true })
    .click();
  await expect(page.getByRole("button", { name: /View requisition/ })).toHaveCount(1);
  const orders = await rpc<{ productId: number; plannedQuantity: number }[]>(
    page,
    "mms.orders.list",
  );
  expect(orders.find((o) => o.productId === frame)?.plannedQuantity).toBe(10_000);
  const prs = await rpc<ImsDocumentDto[]>(page, "ims.documents.list", {
    kind: "purchaseRequisition",
  });
  expect(prs[0]?.lines[0]?.quantityMilli).toBe(20_000);
  await page.screenshot({ path: "docs/planning/mrp-multilevel.png", fullPage: true });
  expect(errors).toEqual([]);
});
