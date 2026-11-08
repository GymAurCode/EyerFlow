"use strict";

const { mkdtempSync, readdirSync, readFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { _electron: electron } = require("@playwright/test");

const dataDir = mkdtempSync(join(tmpdir(), "eyerstock-flow-"));

(async () => {
  const app = await electron.launch({
    args: [process.cwd(), `--eyerstock-e2e=${dataDir}`],
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "production",
      ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
      EYERSTOCK_DATA_DIR: dataDir,
      LICENCE_DISABLED: "1",
      DEV_AUTOLOGIN: "0",
    },
    timeout: 60000,
  });

  const page = await app.firstWindow({ timeout: 60000 });
  await page.waitForLoadState("domcontentloaded");
  const fill = async (label, value) => {
    const field = page.getByLabel(label).first();
    await field.waitFor({ state: "visible", timeout: 20000 });
    await field.fill(value);
  };
  await page.getByText("Create administrator account").waitFor({ timeout: 30000 });
  await fill(/company name/i, "Blue Water Trading");
  await fill(/your name/i, "Test Administrator");
  await fill(/^username/i, "admin");
  await fill(/^password/i, "Water#2026");
  await page.getByRole("button", { name: /finish setup/i }).click();
  await page.getByRole("button", { name: /^sign in$/i }).waitFor({ timeout: 30000 });
  await fill(/username/i, "admin");
  await fill(/password/i, "Water#2026");
  await page.getByRole("button", { name: /^sign in$/i }).click();
  const keep = page.getByRole("button", { name: /^keep current$/i });
  if (await keep.isVisible().catch(() => false)) await keep.click();
  await page.getByRole("navigation").first().waitFor({ timeout: 30000 });

  const rpc = (method, payload = {}) =>
    page.evaluate(
      async ([m, p]) => {
        const result = await window.api.invoke(m, p);
        return { ok: result.ok, error: result.error?.message ?? null, data: result.data };
      },
      [method, payload],
    );

  const today = new Date().toISOString().slice(0, 10);
  const product = async (name, sku) =>
    (await rpc("products.save", {
      name,
      nameAr: null,
      sku,
      barcode: null,
      description: null,
      category: "Manufacturing",
      reorderLevelMilli: 0,
      salePriceFils: 15000,
      vatTreatment: "standard",
      isSerialised: false,
      isService: false,
      warrantyMonths: 12,
    })).data;

  const supplier = (await rpc("parties.save", {
    kind: "supplier",
    name: "Gulf Plastics",
    phone: null,
    email: null,
    trn: null,
    addressLine: null,
    emirate: null,
  })).data;

  const raw = await product("Filter housing", "RAW-001");
  const finished = await product("Inline filter", "FIN-001");

  console.log("purchase:", JSON.stringify(await rpc("documents.save", {
    kind: "purchaseInvoice",
    partyId: supplier.id,
    issueDate: today,
    dueDate: null,
    status: "issued",
    notes: null,
    reason: null,
    lines: [
      {
        productId: raw.id,
        description: "Filter housing",
        quantityMilli: 100000,
        unitPriceFils: 4000,
        vatTreatment: "standard",
        unitCostFils: 4000,
      },
    ],
  })).slice(0, 300));

  const route = (await rpc("mms.routes.save", {
    name: "Filter assembly",
    status: "approved",
    effectiveFrom: today,
  })).data;
  console.log("route:", route?.id);
  console.log("op:", JSON.stringify(await rpc("mms.routeOperations.save", {
    routeId: route.id,
    operationCode: "OP-10",
    name: "Assemble filter",
    sequence: 1,
    cycleTimeMinutes: 5,
  })).slice(0, 300));

  const bom = (await rpc("mms.boms.save", {
    productId: finished.id,
    name: "Inline filter BOM",
    bomType: "assembly",
    baseOutputQuantity: 1000,
    outputUnit: "pcs",
    routingId: route.id,
  })).data;
  console.log("bom:", bom?.id, bom?.number);

  console.log("component:", JSON.stringify(await rpc("mms.bomComponents.save", {
    bomId: bom.id,
    componentProductId: raw.id,
    quantityPerUnit: 1000,
    unit: "pcs",
  })).slice(0, 300));

  console.log("approve:", JSON.stringify((await rpc("mms.boms.approve", { id: bom.id })).data?.status));

  const mo = (await rpc("mms.orders.save", {
    productId: finished.id,
    bomId: bom.id,
    plannedQuantity: 10000,
    routeId: route.id,
  })).data;
  console.log("mo:", mo?.id, mo?.number);

  console.log("stock before:", JSON.stringify((await rpc("products.get", { id: raw.id })).data?.quantityMilli));
  console.log("release:", JSON.stringify(await rpc("mms.orders.release", { id: mo.id })).slice(0, 500));

  const logs = join(dataDir, "logs");
  const latest = readdirSync(logs).sort().pop();
  const text = readFileSync(join(logs, latest), "utf8");
  console.log("--- main log tail ---");
  console.log(text.split("\n").slice(-25).join("\n"));

  await app.close();
})().catch((error) => {
  console.error("FLOW FAILED:", error);
  process.exitCode = 1;
});
