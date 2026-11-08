/**
 * Launch a packaged build and check that its window paints.
 *
 * The unpacked build is what the installer ships, and it is the only place
 * where the asar, the file protocol and the bundled renderer are all in play
 * at once. A window that comes up blank here is a window the user sees blank.
 *
 * The state is read from the main process rather than from a page handle: the
 * window is created with `show: false` and only shown once the renderer has
 * painted, so a page handle may not exist at all until the app is up.
 *
 *   npx tsx tools/print-preview/packaged-check.ts [exe]
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "@playwright/test";

async function main(): Promise<void> {
  const exe = resolve(
    process.argv[2] ?? join(process.cwd(), "release", "win-unpacked", "EyerStock.exe"),
  );

  if (!existsSync(exe)) {
    process.stderr.write(`no packaged build at ${exe}\n`);
    process.exitCode = 1;
    return;
  }

  /*
   * A packaged build opens the real data folder, and that folder holds the
   * shop's database. The check runs against a copy in a temporary folder so it
   * can never migrate, or otherwise touch, the real one.
   */
  const dataDir = mkdtempSync(join(tmpdir(), "eyerstock-packaged-"));

  const app = await electron.launch({
    executablePath: exe,
    args: [],
    cwd: process.cwd(),
    env: { ...process.env, EYERSTOCK_DATA_DIR: dataDir },
    timeout: 60_000,
  });

  let state: unknown = { error: "no window yet" };

  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));

    state = await app.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (window === undefined) return { error: "no window" };
      try {
        return await window.webContents.executeJavaScript(
          `(() => ({
            readyState: globalThis.document.readyState,
            theme: globalThis.document.documentElement.getAttribute("data-theme"),
            text: globalThis.document.body.innerText.trim().slice(0, 200),
            bodyLength: globalThis.document.body.innerHTML.length,
            scripts: globalThis.document.scripts.length,
            hasApi: typeof globalThis.api,
          }))()`,
        );
      } catch (error) {
        return { error: String(error).slice(0, 120), url: window.webContents.getURL() };
      }
    });

    const text = (state as { text?: string }).text;
    if (typeof text === "string" && text.length > 20) break;
  }

  const info = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    return {
      windows: BrowserWindow.getAllWindows().length,
      visible: window?.isVisible() ?? false,
      url: window?.webContents.getURL() ?? "(none)",
    };
  });

  process.stderr.write(`window: ${JSON.stringify(info)}\n`);
  process.stderr.write(`state: ${JSON.stringify(state)}\n`);

  await app.close();
  rmSync(dataDir, { recursive: true, force: true });

  const text = (state as { text?: string }).text;
  if (typeof text !== "string" || text.length < 20) {
    process.stderr.write("the packaged window is blank\n");
    process.exitCode = 1;
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`packaged check failed: ${String(error)}\n`);
  process.exitCode = 1;
});
