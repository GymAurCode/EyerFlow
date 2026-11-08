"use strict";

/* Temporary diagnostic: launch the built app with a fresh data folder, complete
   setup, sign in, and dump what the sidebar actually renders. */

const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { _electron: electron } = require("@playwright/test");

const dataDir = process.argv[2] ?? mkdtempSync(join(tmpdir(), "eyerstock-diag-"));
const fresh = process.argv[2] === undefined;

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

  app.process().stderr?.on("data", (chunk) => console.log("[main]", String(chunk).trim()));
  const page = await app.firstWindow({ timeout: 60000 });
  page.on("console", (message) => console.log("[renderer]", message.type(), message.text()));
  page.on("pageerror", (error) => console.log("[pageerror]", error.message));
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(2500);

  const fill = async (label, value) => {
    const field = page.getByLabel(label).first();
    await field.waitFor({ state: "visible", timeout: 20000 });
    await field.fill(value);
  };

  if (fresh) {
    await page.getByText("Create administrator account").waitFor({ timeout: 30000 });
    await fill(/company name/i, "Blue Water Trading");
    await fill(/your name/i, "Test Administrator");
    await fill(/^username/i, "admin");
    await fill(/^password/i, "Water#2026");
    await page.getByRole("button", { name: /finish setup/i }).click();
    await page.getByRole("button", { name: /^sign in$/i }).waitFor({ timeout: 30000 });
  }

  await fill(/username/i, "admin");
  await fill(/password/i, "Water#2026");
  await page.getByRole("button", { name: /^sign in$/i }).click();

  const keep = page.getByRole("button", { name: /^keep current$/i });
  if (await keep.isVisible().catch(() => false)) await keep.click();
  await page.getByRole("navigation").first().waitFor({ timeout: 30000 });
  await page.waitForTimeout(1200);

  console.log("--- sidebar ---");
  console.log(await page.locator("aside[aria-label='Main navigation']").innerText());

  const rpc = await page.evaluate(async () => {
    const api = window.api;
    const call = async (method, payload = {}) => {
      const result = await api.invoke(method, payload);
      return { ok: result.ok, error: result.error?.message ?? null, data: result.data };
    };
    const user = await call("auth.currentUser");
    return {
      permissions: user.data?.permissions?.map((p) => `${p.module}:${p.action}`) ?? null,
      dashboard: await call("mms.productionDashboard"),
    };
  });
  console.log("--- rpc ---");
  console.dir(rpc, { depth: 5 });

  await page.screenshot({ path: join(process.cwd(), "mms-diagnose.png") });
  console.log("dataDir", dataDir);
  await app.close();
})().catch((error) => {
  console.error("DIAGNOSTIC FAILED:", error);
  process.exitCode = 1;
});
