/**
 * Launch the app from the working directory and check that the renderer paints.
 *
 * The packaged app runs an obfuscated main process; this runs the same
 * `dist/main` without the asar, so the two can be told apart.
 *
 *   npx tsx tools/print-preview/main-check.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, type Page } from "@playwright/test";

async function main(): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "eyerstock-main-"));

  const app = await electron.launch({
    args: [process.cwd()],
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "production",
      ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
      EYERSTOCK_DATA_DIR: dataDir,
      LICENCE_DISABLED: "1",
    },
    timeout: 60_000,
  });

  const page: Page = await app.firstWindow({ timeout: 60_000 });
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(5000);

  const state = await page.evaluate(() => {
    const w = globalThis as unknown as {
      document: { readyState: string; body: { innerText: string; innerHTML: string }; documentElement: { className: string } };
      api?: unknown;
    };
    return {
      readyState: w.document.readyState,
      htmlClass: w.document.documentElement.className,
      text: w.document.body.innerText.trim().slice(0, 160),
      rootHtml: w.document.body.innerHTML.slice(0, 160),
      hasApi: typeof w.api,
    };
  });

  const failed: string[] = [];
  page.on("requestfailed", (request) => {
    failed.push(`${request.url()} (${request.failure()?.errorText ?? "failed"})`);
  });

  await page.reload().catch((error: unknown) => {
    process.stderr.write(`reload failed: ${String(error)}\n`);
  });
  await page.waitForTimeout(3000);

  process.stderr.write(`state: ${JSON.stringify(state)}\n`);
  process.stderr.write(`failed requests: ${failed.length}\n`);
  for (const request of failed.slice(0, 10)) process.stderr.write(`  ${request}\n`);

  await page.screenshot({ path: join(process.cwd(), "print-preview-out", "main-check.png") });
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
}

void main().catch((error: unknown) => {
  process.stderr.write(`main check failed: ${String(error)}\n`);
  process.exitCode = 1;
});
