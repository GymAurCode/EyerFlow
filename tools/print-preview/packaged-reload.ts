/**
 * Load the renderer again from inside the running app.
 *
 * The app's own window comes up with an empty document. This asks the app to
 * load the renderer a second time, by URL and by file, and reports what
 * happens each time - which separates "the document cannot be served" from
 * "this particular call cannot be served".
 *
 *   npx tsx tools/print-preview/packaged-reload.ts [exe]
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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

  const app = await electron.launch({
    executablePath: exe,
    args: [],
    cwd: process.cwd(),
    timeout: 60_000,
  });

  await new Promise((resolve) => setTimeout(resolve, 8000));

  const result = await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) return { error: "no window" };

    const read = async (label: string): Promise<Record<string, unknown>> => {
      try {
        const info = await window.webContents.executeJavaScript(
          `(() => ({
            readyState: globalThis.document.readyState,
            text: globalThis.document.body.innerText.trim().slice(0, 120),
            bodyLength: globalThis.document.body.innerHTML.length,
            scripts: globalThis.document.scripts.length,
          }))()`,
        );
        return { label, url: window.webContents.getURL(), ...(info as object) };
      } catch (error) {
        return { label, url: window.webContents.getURL(), error: String(error).slice(0, 120) };
      }
    };

    const before = await read("as the app left it");

    let byUrl = "not attempted";
    try {
      await window.webContents.loadURL(
        pathToFileURL(
          join(
            String(window.webContents.getURL()).split("/dist/")[0] ?? "",
            "dist",
            "renderer",
            "index.html",
          ),
        ).href,
      );
      byUrl = "loaded";
    } catch (error) {
      byUrl = `failed: ${String(error).slice(0, 120)}`;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const afterUrl = await read("after loadURL");

    return { before, byUrl, afterUrl };
  });

  process.stderr.write(`${JSON.stringify(result, null, 2)}\n`);

  await app.close();
}

void main().catch((error: unknown) => {
  process.stderr.write(`reload check failed: ${String(error)}\n`);
  process.exitCode = 1;
});
