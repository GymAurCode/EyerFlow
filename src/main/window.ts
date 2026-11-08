/**
 * Hardened BrowserWindow construction.
 *
 * Every setting here closes off a specific escape route. The renderer handles
 * untrusted input (imported spreadsheets, barcode scanner keystrokes, invoice
 * text), so it is treated as untrusted even though it is our own bundle.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Session } from "electron";
import { BrowserWindow, shell } from "electron";
import {
  CONTENT_SECURITY_POLICY,
  DEV_CONTENT_SECURITY_POLICY,
} from "../shared/content-security-policy";
import type { Logger } from "./logger";

/**
 * Apply the Content-Security-Policy as a response header.
 *
 * A packaged build loads the renderer from `file://`, where no response header
 * exists, so the <meta> tag in `src/renderer/index.html` is what governs it.
 * This header is the belt to that braces: it covers any document the renderer
 * actually loads over http, where the meta tag would arrive after the response
 * had already begun.
 *
 * The header is only ever added to an http response. A `file://` response has
 * no header to speak of, and adding one to it is not merely redundant: the
 * file:// handler serves the renderer out of the asar archive, and a response
 * with headers it did not produce is not served at all. The window then opens
 * on an empty document - a blank window with no error anywhere.
 *
 * Dev gets the relaxed policy because the same rule that refuses a remote
 * script would also refuse Vite's HMR websocket - and a header and a meta tag
 * are combined, not alternatives, so the two must agree.
 */
export function applyContentSecurityPolicy(session: Session, isDev: boolean): void {
  const policy = isDev ? DEV_CONTENT_SECURITY_POLICY : CONTENT_SECURITY_POLICY;

  session.webRequest.onHeadersReceived((details, callback) => {
    if (!details.url.startsWith("http://") && !details.url.startsWith("https://")) {
      callback({});
      return;
    }

    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [policy],
      },
    });
  });
}

const DEV_SERVER_ORIGIN = "http://localhost:5273";
const DEV_SERVER_WS_ORIGIN = "ws://localhost:5273";

/**
 * The page shown when the renderer cannot be loaded.
 *
 * A blank window is the worst possible outcome: the user cannot tell whether
 * the app is still starting, whether it has crashed, or whether it is waiting
 * for something from them. This says what happened and where to look.
 */
function loadFailurePage(reason: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>EyerStock could not start</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        background: #f8fafc;
        color: #0f172a;
        font-family: "Segoe UI", system-ui, sans-serif;
      }
      main {
        max-width: 34rem;
        padding: 2rem;
        background: #ffffff;
        border: 1px solid #e2e8f0;
        border-radius: 12px;
      }
      h1 { font-size: 1.1rem; margin: 0 0 0.5rem; }
      p { margin: 0 0 0.75rem; font-size: 0.9rem; color: #475569; line-height: 1.5; }
      code { background: #f1f5f9; padding: 0.1rem 0.3rem; border-radius: 4px; }
    </style>
  </head>
  <body>
    <main>
      <h1>EyerStock could not open its window</h1>
      <p>The application started, but its interface could not be loaded${reason === "" ? "" : `: ${reason}`}.</p>
      <p>Your data has not been changed. Close this window and open EyerStock again; if it keeps happening, the log in the app's data folder has the details.</p>
    </main>
  </body>
</html>`;
}

export interface WindowOptions {
  readonly rendererUrl: string;
  readonly preloadPath: string;
  readonly isDev: boolean;
  readonly log: Logger;
  /** Per-session token, handed to the renderer by the preload script. */
  readonly token: string;
}

export function createMainWindow(options: WindowOptions): BrowserWindow {
  // The application logo on the title bar and taskbar: same artwork as the
  // installer icon, generated from assets/Logo.png by `npm run icons`. In a
  // packaged build it resolves to <app>/build/icon.ico (see electron-builder's
  // `files`); in dev, to the repository's build/. A missing file is not fatal -
  // Electron logs a warning and falls back to its default icon.
  const iconPath = join(__dirname, "..", "..", "build", "icon.ico");

  // Where the renderer bundle has to be, and whether it can be read from here.
  // A packaged build serves it out of the asar archive, and an archive that
  // cannot be read leaves the window empty with nothing on screen to explain
  // why - so the answer is written down.
  const rendererPath = join(__dirname, "..", "renderer", "index.html");
  options.log.info("Renderer bundle", {
    path: rendererPath,
    exists: existsSync(rendererPath),
    preloadExists: existsSync(options.preloadPath),
  });

  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1100,
    minHeight: 650,
    show: false,
    backgroundColor: "#f8fafc",
    title: "EyerStock",
    autoHideMenuBar: true,
    // Spread rather than a plain `icon:` because the property is optional and
    // assigning undefined to it is an error under exactOptionalPropertyTypes.
    ...(existsSync(iconPath) ? { icon: iconPath } : {}),
    webPreferences: {
      preload: options.preloadPath,
      // The three settings that matter most:
      contextIsolation: true, // preload runs in its own world, not the page's
      nodeIntegration: false, // no `require` in the renderer
      sandbox: true, // OS-level sandbox on the renderer process
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      spellcheck: false,
      // Passed to the preload via process.argv so the renderer can present the
      // token without it appearing in any bundled source.
      additionalArguments: [`--eyerstock-token=${options.token}`],
    },
  });

  // Paint only once the app is ready, so the user never sees a white flash.
  window.once("ready-to-show", () => {
    window.show();
  });

  /*
   * The renderer failing to load is the one failure the user cannot act on: the
   * window comes up empty and there is nothing on screen to read. It is also
   * the failure that is hardest to diagnose, because the main process is
   * perfectly happy - it logged that it started, and then nothing happens.
   *
   * So the outcome is written to the log, and a window that would otherwise be
   * blank is replaced with a page that says what happened.
   */
  window.webContents.on("did-finish-load", () => {
    options.log.info("The renderer loaded");
  });

  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, url) => {
    options.log.error("The renderer failed to load", {
      errorCode,
      errorDescription,
      url,
    });

    // -3 is ERR_ABORTED, which a navigation that is replaced by another one
    // reports. It is not a failure and must not be shown as one.
    if (errorCode === -3) return;

    void window.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(loadFailurePage(errorDescription))}`,
    );
  });

  window.webContents.on("render-process-gone", (_event, details) => {
    options.log.error("The renderer process stopped", { reason: details.reason });
  });

  window.webContents.on("preload-error", (_event, preloadPath, error) => {
    options.log.error("The preload script failed", {
      preloadPath,
      message: error.message,
    });
  });

  // Block all navigation away from the app UI.
  window.webContents.on("will-navigate", (event, url) => {
    const target = new URL(url);
    const allowed = options.isDev && target.origin === DEV_SERVER_ORIGIN;

    if (!allowed) {
      options.log.warn("Blocked navigation attempt", { url });
      event.preventDefault();
    }
  });

  // Block in-page redirects to external sites too.
  window.webContents.on("will-redirect", (event, url) => {
    event.preventDefault();
    options.log.warn("Blocked redirect attempt", { url });
  });

  // New windows (window.open, target=_blank) are never legitimate here. Deny
  // them all, and never hand a webview or Node access to the opener.
  window.webContents.setWindowOpenHandler(({ url }) => {
    options.log.warn("Blocked window.open attempt", { url });

    // External links (documentation, mailto for a supplier) are opened in the OS
    // browser instead, after confirming the scheme is safe.
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "https:" || parsed.protocol === "mailto:") {
        void shell.openExternal(url);
      } else {
        options.log.warn("Refused to open external URL with unsafe scheme", { url });
      }
    } catch {
      options.log.warn("Refused to open malformed external URL", { url });
    }

    return { action: "deny" };
  });

  // No webview tag, ever.
  window.webContents.on("will-attach-webview", (event) => {
    event.preventDefault();
    options.log.warn("Blocked webview attachment attempt");
  });

  // Disable DevTools in production
  if (!options.isDev) {
    window.webContents.on("devtools-opened", () => {
      window.webContents.closeDevTools();
    });
    // Also disable the DevTools keyboard shortcuts
    window.webContents.on("before-input-event", (event, input) => {
      if (
        input.control &&
        input.shift &&
        (input.key === "I" || input.key === "J" || input.key === "C")
      ) {
        event.preventDefault();
      }
      if (input.key === "F12") {
        event.preventDefault();
      }
    });
  }

  // Permission requests (camera, geolocation, notifications) have no legitimate
  // use in a local inventory app.
  //
  // Clipboard *writes* are the one exception. Chromium gates
  // `navigator.clipboard.writeText` behind the `clipboard-sanitized-write`
  // permission check, so denying every permission here also denied every copy
  // button in the app - "Copy machine ID" on the activation screen failed with
  // a NotAllowedError and nothing was copied. Writing to the clipboard exposes
  // nothing to the renderer, so it is allowed; *reading* the clipboard stays
  // blocked, which leaves paste working only from a user gesture.
  window.webContents.session.setPermissionRequestHandler((_contents, permission, callback) => {
    const granted = permission === "clipboard-sanitized-write";
    if (!granted) options.log.warn("Blocked permission request", { permission });
    callback(granted);
  });
  window.webContents.session.setPermissionCheckHandler(
    (_contents, permission) => permission === "clipboard-sanitized-write",
  );

  // A renderer that never reaches the network is the strongest guarantee we
  // have; a stray fetch is a bug and should be visible in the log.
  //
  // Dev additionally allows the dev server's websocket scheme: Vite's HMR
  // client connects to ws://localhost:5273 and nothing else, so the HMR socket
  // is opened without weakening the rule for any other origin.
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    const isDevServer =
      options.isDev &&
      (details.url.startsWith(DEV_SERVER_ORIGIN) || details.url.startsWith(DEV_SERVER_WS_ORIGIN));
    const allowed =
      isDevServer ||
      details.url.startsWith("file:") ||
      details.url.startsWith("devtools:") ||
      details.url.startsWith("blob:") ||
      details.url.startsWith("data:");

    if (!allowed) {
      options.log.warn("Blocked network request from renderer", { url: details.url });
    }

    callback({ cancel: !allowed });
  });

  if (options.isDev) {
    void window.loadURL(options.rendererUrl);
  } else {
    // __dirname is dist/main, so the renderer bundle sits alongside it.
    void window.loadFile(join(__dirname, "..", "renderer", "index.html"));
  }

  return window;
}
