/**
 * Load the app against a running dev server and report the renderer's errors.
 *
 *   npx tsx tools/print-preview/dev-check.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, type Page } from "@playwright/test";

async function main(): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "eyerstock-dev-"));

  const app = await electron.launch({
    args: [process.cwd(), `--eyerstock-e2e=${dataDir}`],
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "development",
      ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
      EYERSTOCK_DATA_DIR: dataDir,
      LICENCE_DISABLED: "1",
    },
    timeout: 60_000,
  });

  const page: Page = await app.firstWindow({ timeout: 60_000 });
  await page.waitForLoadState("domcontentloaded");

  const messages: string[] = [];
  page.on("pageerror", (error: Error) => {
    messages.push(`pageerror: ${error.message}`);
  });
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      messages.push(`console.${message.type()}: ${message.text()}`);
    }
  });

  await page.reload();
  await page.waitForTimeout(6000);

  const body = await page.evaluate(
    () => (globalThis as unknown as { document: { body: { innerText: string } } }).document.body.innerText.slice(0, 500),
  );

  process.stderr.write(`--- renderer messages ---\n${messages.join("\n")}\n`);
  process.stderr.write(`--- first screen text ---\n${body}\n`);
  await page.screenshot({ path: join(process.cwd(), "print-preview-out", "dev-white-screen.png") });

  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
}

void main().catch((error: unknown) => {
  process.stderr.write(`dev check failed: ${String(error)}\n`);
  process.exitCode = 1;
});
