/**
 * Screenshot the packaged application.
 *
 * Playwright cannot inject itself into a packaged Electron build, so the app is
 * launched with a remote debugging port and driven over the DevTools protocol
 * instead. That is the only way to see what the shipped build actually draws.
 *
 *   npx tsx tools/print-preview/packaged-shot.ts [exe]
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";

const PORT = 9333;

async function main(): Promise<void> {
  const exe = resolve(
    process.argv[2] ?? join(process.cwd(), "release", "win-unpacked", "EyerStock.exe"),
  );

  if (!existsSync(exe)) {
    process.stderr.write(`no packaged build at ${exe}\n`);
    process.exitCode = 1;
    return;
  }

  const { spawn } = await import("node:child_process");
  const child = spawn(exe, [`--remote-debugging-port=${String(PORT)}`], {
    detached: false,
    stdio: "ignore",
  });

  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | null = null;

  try {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      try {
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${String(PORT)}`);
        break;
      } catch {
        continue;
      }
    }

    if (browser === null) {
      process.stderr.write("could not attach to the packaged app\n");
      process.exitCode = 1;
      return;
    }

    const contexts = browser.contexts();
    const pages = contexts.flatMap((context) => context.pages());
    const page = pages[0];

    if (page === undefined) {
      process.stderr.write("the packaged app has no page\n");
      process.exitCode = 1;
      return;
    }

    await page.waitForTimeout(6000);
    await page.screenshot({ path: join(process.cwd(), "print-preview-out", "packaged.png") });

    const text = await page.evaluate(
      () => (globalThis as unknown as { document: { body: { innerText: string } } }).document.body.innerText,
    );
    process.stderr.write(`packaged window text: ${text.slice(0, 200)}\n`);

    if (text.trim().length < 20) {
      process.stderr.write("the packaged window is blank\n");
      process.exitCode = 1;
    }
  } finally {
    await browser?.close();
    child.kill();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`packaged shot failed: ${String(error)}\n`);
  process.exitCode = 1;
});
