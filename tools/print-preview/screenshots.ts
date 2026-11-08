/**
 * Screenshots of the reporting and record-action screens.
 *
 * A one-off look at what the upgrade looks like in the running application.
 *
 *   npx tsx tools/print-preview/screenshots.ts [outDir]
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";

const outDir = resolve(process.argv[2] ?? join(process.cwd(), "print-preview-out"));

async function main(): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "eyerstock-shots-"));

  const app: ElectronApplication = await electron.launch({
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
  await page.setViewportSize({ width: 1500, height: 950 });

  // First-run setup.
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

  // Company details, so the printed documents have a real header.
  await page.evaluate(async () => {
    const api = (
      globalThis as unknown as { api: { invoke: (m: string, p: unknown) => Promise<unknown> } }
    ).api;
    await api.invoke("settings.update", {
      companyName: "Bluewave Water Solutions",
      companyTrn: "100428836500003",
      companyAddress: "Shop 12, Al Nakheel Street\nAl Quoz First\nDubai, United Arab Emirates",
      companyPhone: "+971 4 339 8120",
      companyEmail: "accounts@bluewavewater.ae",
    });
  });
  await page.reload();
  await page.getByRole("navigation").first().waitFor({ timeout: 60_000 });

  const shot = async (name: string): Promise<void> => {
    await page.waitForTimeout(700);
    await page.screenshot({ path: join(outDir, `${name}.png`) });
    process.stderr.write(`wrote ${name}.png\n`);
  };

  // Reports - the builder.
  await page
    .getByRole("link", { name: /^reports$/i })
    .first()
    .click();
  await page.waitForTimeout(900);
  await shot("reports-builder");

  // Reports - the preview.
  await page
    .getByRole("button", { name: /sales report/i })
    .first()
    .click();
  await page.getByRole("button", { name: /generate report/i }).click();
  await page.locator('iframe[title$="preview"]').waitFor({ timeout: 30_000 });
  await page.waitForTimeout(1200);
  await shot("reports-preview");

  // Products - the record actions.
  await page
    .getByRole("link", { name: /^products$/i })
    .first()
    .click();
  await page.waitForTimeout(900);
  await shot("products");

  // The print preview: the A4 sheet, shown before anything is printed.
  await page.evaluate(async () => {
    const api = (
      globalThis as unknown as { api: { invoke: (m: string, p: unknown) => Promise<unknown> } }
    ).api;
    await api.invoke("products.save", {
      name: "Inline UV steriliser, 40 GPM, stainless steel",
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
  await page.waitForTimeout(900);

  const productRow = page.getByRole("row", { name: /Inline UV steriliser/i }).first();
  await productRow.waitFor({ state: "visible", timeout: 30_000 });
  await productRow.getByRole("button", { name: /row actions/i }).click();
  await page.getByRole("menuitem", { name: /^print$/i }).click();
  await page.getByRole("dialog").waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForTimeout(1500);
  await shot("print-preview-a4");

  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
}

main().catch((error: unknown) => {
  process.stderr.write(`screenshots failed: ${String(error)}\n`);
  process.exitCode = 1;
});
