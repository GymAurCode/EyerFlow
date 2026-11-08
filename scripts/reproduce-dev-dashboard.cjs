"use strict";

/* Temporary verification: launch the built app against the real dev data folder,
   open the manufacturing module and capture each screen. */

const { join } = require("node:path");
const { mkdirSync } = require("node:fs");
const { _electron: electron } = require("@playwright/test");

const dataDir = join(process.cwd(), ".tmp", "mms-existing-2");
const outDir = join(process.cwd(), "docs", "mms-verify");
mkdirSync(outDir, { recursive: true });

(async () => {
  const app = await electron.launch({
    args: [process.cwd(), `--eyerstock-e2e=${dataDir}`],
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "development",
      ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
      EYERSTOCK_DATA_DIR: dataDir,
      LICENCE_DISABLED: "1", EYERSTOCK_DEBUG_ERR: join(process.cwd(), "docs", "dashboard-original-error.log"),
    },
    timeout: 60000,
  });

  const page = await app.firstWindow({ timeout: 60000 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(5000); console.log("RPC", JSON.stringify(await page.evaluate(() => window.api.invoke("mms.dashboard", {}))));

  console.log("url:", page.url());
  console.log("rail:", (await page.locator("aside[aria-label='Main navigation']").innerText()).replace(/\n+/g, " | "));

  const rail = page.getByRole("complementary", { name: "Main navigation" });
  await page.screenshot({ path: join(outDir, "01-sidebar.png") });

  await rail.getByRole("button", { name: /manufacturing/i }).click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(outDir, "02-manufacturing-expanded.png") });

  console.log("mms groups:", (await rail.innerText()).replace(/\n+/g, " | "));

  await rail.getByRole("link", { name: "Production Dashboard" }).click();
  await page.waitForTimeout(1500);
  console.log("dashboard url:", page.url());
  await page.screenshot({ path: join(outDir, "03-production-dashboard.png") });

  await rail.getByRole("button", { name: /engineering/i }).click();
  await rail.getByRole("link", { name: /bills of materials/i }).click();
  await page.waitForTimeout(900);
  console.log("boms url:", page.url());
  await page.screenshot({ path: join(outDir, "04-boms.png") });

  await rail.getByRole("button", { name: /production operations/i }).click();
  await rail.getByRole("link", { name: /manufacturing orders/i }).click();
  await page.waitForTimeout(900);
  console.log("mos url:", page.url());
  await page.screenshot({ path: join(outDir, "05-manufacturing-orders.png") });

  await rail.getByRole("link", { name: /work orders/i }).click();
  await page.waitForTimeout(900);
  console.log("wos url:", page.url());
  await page.screenshot({ path: join(outDir, "06-work-orders.png") });

  await rail.getByRole("button", { name: /production control/i }).click();
  await rail.getByRole("link", { name: /work in progress/i }).click();
  await page.waitForTimeout(900);
  console.log("wip url:", page.url());
  await page.screenshot({ path: join(outDir, "07-wip.png") });

  console.log("console errors:", errors.length === 0 ? "none" : errors.join(" || "));
  await app.close();
})().catch((error) => {
  console.error("VERIFY FAILED:", error);
  process.exitCode = 1;
});



