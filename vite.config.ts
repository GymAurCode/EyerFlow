import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vite";
import { DEV_CONTENT_SECURITY_POLICY } from "./src/shared/content-security-policy";

/**
 * Development-only relaxation of the renderer's CSP.
 *
 * `src/renderer/index.html` ships a locked-down policy because a packaged
 * build is loaded from disk via file://, where no response header is available.
 * In `vite dev` that same policy blocks the toolchain itself:
 *   - `connect-src 'none'` refuses the HMR client's ws:// socket,
 *   - the React Fast Refresh preamble is injected as an inline <script>,
 *   - Vite serves some modules and assets from blob: URLs.
 * The replacement is the same policy the dev-mode response header installs (see
 * `src/main/window.ts`), because a header and a meta tag are combined rather
 * than treated as alternatives. `vite build` keeps the strict meta tag.
 */
function devContentSecurityPolicy(): Plugin {
  return {
    name: "eyerstock:dev-csp",
    apply: "serve",
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        return html.replace(
          /(<meta\s+http-equiv="Content-Security-Policy"\s+content=")[^"]*(")/i,
          (_match, open: string, close: string) => `${open}${DEV_CONTENT_SECURITY_POLICY}${close}`,
        );
      },
    },
  };
}

// Renderer is built as a relative-path bundle so Electron can load it from
// disk via file:// with no local web server (100% offline requirement).
export default defineConfig({
  root: "src/renderer",
  base: "./",
  plugins: [react(), devContentSecurityPolicy()],
  resolve: {
    alias: {
      "@shared": new URL("./src/shared", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
      "@assets": new URL("./assets", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
    },
  },
  build: {
    outDir: "../../dist/renderer",
    emptyOutDir: true,
    sourcemap: true,
    target: "chrome120",
  },
  server: {
    port: 5273,
    strictPort: true,
  },
});
