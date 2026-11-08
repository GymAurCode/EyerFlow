/**
 * Check the application's own log for errors.
 *
 * The upgrade touches the print path, the reports and several record screens.
 * This walks the app through those and then reads the main-process log, so an
 * exception anywhere along the way shows up as a log entry rather than as a
 * screen that quietly did nothing.
 *
 *   npx tsx tools/print-preview/log-check.ts
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, type Page } from "@playwright/test";

const dataDir = mkdtempSync(join(tmpdir(), "eyerstock-log-"));

async function main(): Promise<void> {
  const app = await electron.launch({
    args: [process.cwd(), `--eyerstock-e2e=${dataDir}`],
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "production",
      ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
      EYERSTOCK_DATA_DIR: dataDir,
      LICENCE_DISABLED: "1",
    },
  });

  const page: Page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const errors: string[] = [];
  page.on("pageerror", (error: Error) => {
    errors.push(`renderer: ${error.message}`);
  });
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });

  await page.getByText("Create administrator account").waitFor({ timeout: 60_000 });
  await page
    .getByLabel(/company name/i)
    .first()
    .fill("Bluewave Water Solutions");
  await page
    .getByLabel(/your name/i)
    .first()
    .fill("Rashid");
  await page
    .getByLabel(/^username/i)
    .first()
    .fill("admin");
  await page
    .getByLabel(/^password/i)
    .first()
    .fill("Water#2026");
  await page.getByRole("button", { name: /finish setup/i }).click();
  await page.getByRole("button", { name: /^sign in$/i }).waitFor({ timeout: 60_000 });
  await page
    .getByLabel(/username/i)
    .first()
    .fill("admin");
  await page
    .getByLabel(/password/i)
    .first()
    .fill("Water#2026");
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await page.getByRole("navigation").first().waitFor({ timeout: 60_000 });

  // Walk the screens the upgrade touched.
  const screens = [
    { link: /^dashboard$/i, name: "Dashboard" },
    { link: /^reports$/i, name: "Reports" },
    { link: /^products$/i, name: "Products" },
    { link: /^customers$/i, name: "Customers" },
    { link: /^suppliers$/i, name: "Suppliers" },
    { link: /^expenses$/i, name: "Expenses" },
    { link: /^sales$/i, name: "Sales" },
    { link: /^purchases$/i, name: "Purchases" },
    { link: /^finance$/i, name: "Finance" },
    { link: /^settings$/i, name: "Settings" },
  ];

  for (const screen of screens) {
    await page.getByRole("link", { name: screen.link }).first().click();
    await page.waitForTimeout(1200);

    // A white screen is an empty page, not an error: nothing failed, the
    // screen simply never painted.
    const text = await page.evaluate(
      () => (globalThis as unknown as { document: { body: { innerText: string } } }).document.body.innerText.trim(),
    );
    if (text.length < 40) {
      errors.push(`blank screen: ${screen.name} rendered ${String(text.length)} characters`);
    }
  }

  // And generate a report, which is the longest path through the new code.
  await page
    .getByRole("link", { name: /^reports$/i })
    .first()
    .click();
  await page.waitForTimeout(600);
  await page
    .getByRole("button", { name: /sales report/i })
    .first()
    .click();
  await page.getByRole("button", { name: /generate report/i }).click();
  await page.locator('iframe[title$="preview"]').waitFor({ timeout: 30_000 });
  await page.waitForTimeout(800);

  // And open a print preview, which is the other long path.
  await page
    .getByRole("link", { name: /^products$/i })
    .first()
    .click();
  await page.waitForTimeout(800);
  await page.evaluate(async () => {
    const api = (
      globalThis as unknown as { api: { invoke: (m: string, p: unknown) => Promise<unknown> } }
    ).api;
    await api.invoke("products.save", {
      name: "Inline UV steriliser, 40 GPM",
      sku: "ITM-00012",
      category: "Filters",
      unit: "pcs",
    });
  });
  await page.reload();
  await page.getByRole("navigation").first().waitFor({ timeout: 60_000 });
  await page
    .getByRole("link", { name: /^products$/i })
    .first()
    .click();
  await page.waitForTimeout(800);
  const productRow = page.getByRole("row", { name: /Inline UV steriliser/i }).first();
  await productRow.waitFor({ state: "visible", timeout: 30_000 });
  await productRow.getByRole("button", { name: /row actions/i }).click();
  await page.getByRole("menuitem", { name: /^print$/i }).click();
  await page.getByRole("dialog").waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForTimeout(1500);

  // The preview must actually contain the document, not an empty frame.
  const previewText = await page
    .frameLocator('iframe[title="Document preview"]')
    .locator("body")
    .innerText()
    .catch((error: unknown) => `no frame: ${String(error)}`);
  if (previewText.trim().length < 40) {
    errors.push(`blank print preview: ${previewText.trim().slice(0, 120)}`);
  } else {
    process.stderr.write(`print preview shows ${String(previewText.trim().length)} characters\n`);
  }

  const logPath = join(dataDir, "logs", "main.log");
  const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";

  const problems = log
    .split(/\r?\n/)
    .filter((line) => /\b(error|fatal|unhandled|exception)\b/i.test(line));

  process.stderr.write(`renderer problems: ${errors.length}\n`);
  for (const error of errors) process.stderr.write(`  ${error}\n`);
  process.stderr.write(`main-process log problems: ${problems.length}\n`);
  for (const problem of problems.slice(0, 20)) process.stderr.write(`  ${problem}\n`);

  await app.close();
  rmSync(dataDir, { recursive: true, force: true });

  if (errors.length > 0 || problems.length > 0) process.exitCode = 1;
}

void main();
