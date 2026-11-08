/**
 * Ask the running application what is in its database.
 *
 * The packaged app is launched with a remote debugging port and driven over
 * the DevTools protocol, because Playwright cannot inject itself into a
 * packaged Electron build. The questions are asked through the app's own RPC
 * bridge, so the answers are the live data.
 *
 *   npx tsx tools/print-preview/packaged-data.ts [exe]
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";

const PORT = 9334;

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

    const page = browser.contexts().flatMap((context) => context.pages())[0];
    if (page === undefined) {
      process.stderr.write("the packaged app has no page\n");
      process.exitCode = 1;
      return;
    }

    await page.waitForTimeout(6000);

    // A string, not a function: Playwright's serializer uses a helper that the
    // packaged renderer does not have.
    const result = await page.evaluate(`(async () => {
      const w = globalThis;
      if (w.api === undefined) return { error: "no bridge" };

      const ask = async (method, payload) => {
        const r = await w.api.invoke(method, payload);
        return r.ok ? r.data : "ERROR: " + (r.error && r.error.message ? r.error.message : "?");
      };

      return {
        screen: w.document.body.innerText.slice(0, 120),
        setup: await ask("auth.setupStatus"),
        products: await ask("products.list", { limit: 5 }),
        parties: await ask("parties.list", { limit: 5 }),
        documents: await ask("documents.list", { limit: 5 }),
      };
    })()`);

    process.stderr.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await browser?.close();
    child.kill();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`packaged data check failed: ${String(error)}\n`);
  process.exitCode = 1;
});
