/**
 * Print preview tool.
 *
 * Renders a document to a PDF the way the app does, and then renders that PDF
 * to page images so the result can be looked at. This is how the printed
 * layout is checked: pagination, repeating table headings, the page footer,
 * and whether a wide table clips at the paper edge.
 *
 *   npx electron tools/print-preview/preview.ts <document.html> [outDir]
 *
 * The document is the same HTML the app hands to the printer, so what comes
 * out here is what comes out of the printer.
 */

import { app, BrowserWindow } from "electron";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const documentPath = resolve(process.argv[2] ?? "");
const outDir = resolve(process.argv[3] ?? join(process.cwd(), "print-preview-out"));
const pageCount = Number.parseInt(process.argv[4] ?? "3", 10);

async function renderPdf(html: string): Promise<Buffer> {
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      javascript: false,
      plugins: true,
    },
  });

  try {
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    // Yield once so layout and any webfonts settle before the snapshot.
    await new Promise((resolve) => setTimeout(resolve, 120));

    return await window.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
      displayHeaderFooter: true,
      headerTemplate: "<div></div>",
      footerTemplate:
        '<div style="width:100%;font-size:8px;font-family:Segoe UI,sans-serif;padding:0 12mm;' +
        'color:#64748b;display:flex;justify-content:space-between;align-items:center;">' +
        "<span>Sales Report</span>" +
        '<span>Page&nbsp;<span class="pageNumber"></span>&nbsp;of&nbsp;<span class="totalPages"></span></span>' +
        "<span></span></div>",
    });
  } finally {
    /*
     * The window is kept open. Electron quits the app when the last window
     * closes, which would end the run before the pages were captured.
     */
  }
}

/**
 * Load the PDF viewer, retrying once.
 *
 * The viewer is a plugin, and it occasionally refuses the first load straight
 * after the renderer produced a PDF - the file is still settling on disk.
 */
async function loadViewer(window: BrowserWindow, url: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await window.loadURL(url);
      return;
    } catch (error) {
      if (attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
  }
}

async function renderPages(pdfPath: string, base: string): Promise<void> {
  const window = new BrowserWindow({
    width: 880,
    height: 1330,
    show: false,
    webPreferences: {
      plugins: true,
      contextIsolation: true,
    },
  });

  try {
    for (let page = 1; page <= pageCount; page += 1) {
      /*
       * The PDF viewer picks the page up from the fragment, and a fragment
       * change alone does not reload the viewer - so each page is loaded from
       * its own copy of the file.
       */
      const pagePath = join(outDir, `${base}-page-${String(page)}.pdf`);
      copyFileSync(pdfPath, pagePath);

      const pageUrl = `${pathToFileURL(pagePath).href}?p=${String(page)}#page=${String(page)}&zoom=60&toolbar=0`;
      await loadViewer(window, pageUrl);
      await new Promise((resolve) => setTimeout(resolve, 2200));

      const image = await window.webContents.capturePage();
      const out = join(outDir, `${base}-p${String(page)}.png`);
      writeFileSync(out, image.toPNG());
      process.stderr.write(`wrote ${out}\n`);
    }
  } finally {
    if (!window.isDestroyed()) window.destroy();
  }
}

app.whenReady().then(async () => {
  try {
    process.stderr.write(`document: ${documentPath}\nout: ${outDir}\npages: ${pageCount}\n`);
    mkdirSync(outDir, { recursive: true });

    const html = readFileSync(documentPath, "utf8");
    const base = basename(documentPath).replace(/\.html$/i, "");

    const pdf = await renderPdf(html);
    const pdfPath = join(outDir, `${base}.pdf`);
    writeFileSync(pdfPath, pdf);
    process.stderr.write(`wrote ${pdfPath} (${pdf.length} bytes)\n`);

    await renderPages(pdfPath, base);
  } catch (error) {
    process.stderr.write(`preview failed: ${String(error)}\n`);
  }
  // Give the writes a moment to reach the disk before the process goes.
  await new Promise((resolve) => setTimeout(resolve, 300));
  app.quit();
});
