import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { completeSetup, launchApp, rpc, todayIso, type TestApp } from "./app";
import type { WmsSnapshot } from "../src/shared/wms";

let app: TestApp;
test.setTimeout(240_000);
test.beforeEach(async () => {
  app = await launchApp();
  await completeSetup(app.window);
});
test.afterEach(async () => {
  await app?.close();
});
async function route(path: string) {
  await app.window.evaluate((p) => {
    window.location.hash = p;
  }, `/wms/${path}`);
}
async function select(page: Page, label: string, option: string) {
  await page.getByRole("dialog").getByLabel(label).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

test("warehouse receiving, pick-pack-dispatch, returns and configuration reconcile in Electron", async () => {
  const page = app.window;
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await route("warehouses");
  await expect(page.getByRole("heading", { name: "Warehouses", exact: true }).last()).toBeVisible();
  await page.getByRole("button", { name: "Create warehouse", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Warehouse code").fill("WH-TEST");
  await dialog.getByLabel(/^Name/).fill("Test warehouse");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("cell", { name: "WH-TEST", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await dialog.getByLabel(/^Name/).fill("Verified test warehouse");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  let state = await rpc<WmsSnapshot>(page, "wms.snapshot", {});
  expect(state.warehouses[0]!.name).toBe("Verified test warehouse");
  const warehouseId = state.warehouses[0]!.id;
  for (const [code, type] of [
    ["REC", "receiving"],
    ["HOLD", "quarantine"],
    ["A01-B01", "storage"],
    ["PACK", "packing"],
  ]) {
    await route("bins");
    await page.getByRole("button", { name: "Create bin", exact: true }).click();
    await select(page, "Warehouse", "WH-TEST · Verified test warehouse");
    await dialog.getByLabel("Unique bin code").fill(code!);
    await select(page, "Bin type", type!);
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).not.toBeVisible();
  }
  const product = await rpc<{ id: number }>(page, "products.save", {
    sku: "WMS-E2E",
    name: "Warehouse sample",
    unit: "pcs",
    vatTreatment: "standard",
    averageCostFils: 100,
  });
  await route("docks");
  await page.getByRole("button", { name: "Create dock door", exact: true }).click();
  await select(page, "Warehouse", "WH-TEST · Verified test warehouse");
  await dialog.getByLabel("Dock code").fill("DOOR-1");
  await dialog.getByLabel("Dock name").fill("Receiving door");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await dialog.getByLabel("Dock name").fill("Verified receiving door");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await route("appointments");
  await page.getByRole("button", { name: "Schedule appointment", exact: true }).click();
  await select(page, "Warehouse", "WH-TEST · Verified test warehouse");
  await select(page, "Dock door", "DOOR-1");
  await dialog.getByLabel("Appointment code").fill("APPT-E2E");
  await dialog.getByLabel("Inbound / ASN reference").fill("SUPPLIER-DELIVERY-001");
  await dialog.getByLabel("Arrival window start").fill(`${todayIso()}T10:00`);
  await dialog.getByLabel("Arrival window end").fill(`${todayIso()}T11:00`);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole("button", { name: "Check in", exact: true }).click();
  await page.getByRole("button", { name: "Start unloading", exact: true }).click();
  await page.getByRole("button", { name: "Complete", exact: true }).click();
  await expect(page.getByRole("cell", { name: "completed", exact: true })).toBeVisible();
  await route("inbounds");
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByRole("button", { name: "Create inbound reference" }).click();
  await select(page, "Warehouse", "WH-TEST · Verified test warehouse");
  await dialog.getByLabel("Inbound source reference").fill("SUPPLIER-DELIVERY-001");
  await select(page, "Product", "WMS-E2E · Warehouse sample");
  await dialog.getByLabel("Expected quantity").fill("100");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole("button", { name: "Mark arrived" }).click();
  await page.getByRole("button", { name: "Receive WMS-E2E", exact: true }).click();
  await select(page, "Receiving bin", "REC");
  await dialog.getByLabel("Actual received quantity").fill("70");
  await dialog.getByLabel("Damaged quantity").fill("5");
  await dialog.getByRole("button", { name: "Post receipt" }).click();
  await expect(dialog).not.toBeVisible();
  state = await rpc<WmsSnapshot>(page, "wms.snapshot", {});
  expect(state.inbounds[0]!.status).toBe("partiallyReceived");
  expect(state.positions.reduce((s, p) => s + p.quantity_milli, 0)).toBe(70_000);
  expect(state.positions.find((p) => p.stock_status === "damaged")?.quantity_milli).toBe(5000);
  await route("putaway");
  await page.getByRole("button", { name: "Scan & confirm", exact: true }).click();
  await dialog.getByLabel("Scan source bin").fill("REC");
  await dialog.getByLabel("Scan SKU / barcode").fill("WMS-E2E");
  await dialog.getByLabel("Scan destination bin").fill("A01-B01");
  await dialog.getByRole("button", { name: "Confirm movement" }).click();
  await expect(dialog).not.toBeVisible();
  state = await rpc<WmsSnapshot>(page, "wms.snapshot", {});
  expect(state.tasks[0]!.status).toBe("completed");
  expect(state.reconciliation).toEqual([]);
  expect(state.positions.find((p) => p.bin === "A01-B01")?.quantity_milli).toBe(65_000);
  expect(state.warehouses[0]!.id).toBe(warehouseId);
  expect(state.products.some((p) => p.id === product.id)).toBe(true);
  await page.reload();
  await expect(page.getByRole("cell", { name: "completed", exact: true })).toBeVisible();
  await route("dispatch-requests");
  await page.getByRole("button", { name: "Create dispatch request" }).click();
  await select(page, "Warehouse", "WH-TEST");
  await dialog.getByLabel("Recipient").fill("Test customer");
  await dialog.getByLabel("Source reference").fill("OUT-001");
  await dialog.getByLabel("Required date").fill(todayIso());
  await select(page, "Product", "WMS-E2E · Warehouse sample");
  await dialog.getByLabel("Requested quantity").fill("20");
  await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole("button", { name: "Release to picking" }).click();
  await select(page, "Packing destination", "PACK");
  await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await route("picking");
  await page.getByRole("button", { name: "Scan pick", exact: true }).click();
  await dialog.getByLabel("Scan source bin").fill("A01-B01");
  await dialog.getByLabel("Scan SKU / barcode").fill("WMS-E2E");
  await dialog.getByLabel("Scan packing bin").fill("PACK");
  await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await route("packing");
  for (const [code, remaining] of [
    ["BOX-001", "20"],
    ["BOX-002", "10"],
  ]) {
    await page.getByRole("button", { name: "Pack carton", exact: true }).click();
    await dialog.getByLabel("Unique carton ID").fill(code!);
    await dialog.getByLabel("Weight (grams)").fill("2000");
    await select(page, "Request line", `WMS-E2E · ${remaining} remaining`);
    await dialog.getByLabel("Scan SKU / barcode").fill("WMS-E2E");
    await dialog.getByLabel("Carton quantity").fill("10");
    await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(dialog).not.toBeVisible();
  }
  await route("staging");
  for (const code of ["BOX-001", "BOX-002"]) {
    await page.getByRole("button", { name: "Scan to staging", exact: true }).click();
    await dialog.getByLabel("Scan carton ID").fill(code);
    await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(dialog).not.toBeVisible();
  }
  await route("dispatch");
  for (const code of ["BOX-001", "BOX-002"]) {
    await page.getByRole("button", { name: "Scan onto vehicle", exact: true }).click();
    await dialog.getByLabel("Scan carton ID").fill(code);
    await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(dialog).not.toBeVisible();
  }
  await page.getByRole("button", { name: "Confirm handover", exact: true }).click();
  await dialog.getByLabel("Carrier", { exact: false }).first().fill("Test carrier");
  await dialog.getByLabel("Vehicle reference").fill("TRUCK-001");
  await dialog.getByLabel("Carrier acknowledgement").fill("Signed by driver");
  await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  state = await rpc<WmsSnapshot>(page, "wms.snapshot", {});
  expect(state.dispatches[0]!.status).toBe("handedOver");
  const handover = {
    id: state.dispatches[0]!.id,
    carrier: "Test carrier",
    vehicle: "TRUCK-001",
    acknowledgement: "Signed by driver",
  };
  await rpc(page, "wms.dispatch.handover", handover);
  await rpc(page, "wms.dispatch.handover", handover);
  state = await rpc<WmsSnapshot>(page, "wms.snapshot", {});
  expect(state.positions.reduce((s, p) => s + p.quantity_milli, 0)).toBe(50_000);
  expect(state.reconciliation).toEqual([]);
  await route("returns");
  await page.getByRole("button", { name: "Receive return", exact: true }).click();
  await select(page, "Original shipped line", `${state.dispatches[0]!.number} · WMS-E2E · 20`);
  await select(page, "Returns / quarantine bin", "HOLD");
  await dialog.getByLabel("Scan SKU / barcode").fill("WMS-E2E");
  await dialog.getByLabel("Returned quantity").fill("5");
  await dialog.getByLabel("Returned condition").fill("Three sealed, two damaged");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole("button", { name: "Inspect return", exact: true }).click();
  await dialog.getByLabel("Approved sellable quantity").fill("3");
  await select(page, "Sellable destination", "A01-B01");
  await dialog.getByLabel("Inspection reason").fill("Inspected all five units");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  state = await rpc<WmsSnapshot>(page, "wms.snapshot", {});
  expect(state.returns[0]!.sellable_milli).toBe(3000);
  expect(state.positions.reduce((s, p) => s + p.quantity_milli, 0)).toBe(55_000);
  expect(state.reconciliation).toEqual([]);
  await route("counts");
  await page.getByRole("button", { name: "Record cycle count", exact: true }).click();
  await select(page, "Bin", "A01-B01");
  await select(page, "Product", "WMS-E2E · Warehouse sample");
  await dialog.getByLabel("Scan bin").fill("A01-B01");
  await dialog.getByLabel("Scan SKU / barcode").fill("WMS-E2E");
  await dialog.getByLabel("Counted quantity").fill("47");
  await dialog
    .getByLabel("Variance / count notes")
    .fill("Physical count awaiting supervisor review");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect((await rpc<WmsSnapshot>(page, "wms.snapshot", {})).counts[0]!.status).toBe("review");
  await route("settings");
  await page.getByLabel("Automatic putaway tasks").click();
  await page.getByRole("option", { name: "Disabled", exact: true }).click();
  await expect(page.getByLabel("Automatic putaway tasks")).toHaveText("Disabled");
  expect((await rpc<WmsSnapshot>(page, "wms.snapshot", {})).settings.autoPutaway).toBe(false);
  await page.getByLabel("Automatic putaway tasks").click();
  await page.getByRole("option", { name: "Enabled", exact: true }).click();
  await expect(page.getByLabel("Automatic putaway tasks")).toHaveText("Enabled");
  mkdirSync("docs/wms-verify", { recursive: true });
  for (const name of [
    "overview",
    "warehouses",
    "bins",
    "docks",
    "appointments",
    "inbounds",
    "receiving",
    "putaway",
    "stock-locator",
    "transfers",
    "reconciliation",
    "tasks",
    "dispatch-requests",
    "picking",
    "packing",
    "staging",
    "dispatch",
    "counts",
    "returns",
    "replenishment",
    "reports",
    "settings",
  ]) {
    await route(name);
    await expect(page.locator("main")).toBeVisible();
    if (name !== "settings") await expect(page.getByText(/Data cutoff:/i)).toBeVisible();
    await page.screenshot({ path: `docs/wms-verify/${name}.png`, fullPage: true });
  }
  expect(errors).toEqual([]);
});
