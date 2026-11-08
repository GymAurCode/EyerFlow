/**
 * The renderer's Content-Security-Policy, in one place.
 *
 * Three deliveries have to agree, and two of them cannot import from `src/main`
 * (the Vite config runs in the toolchain, the print code runs in the main
 * process), so the policy lives here and everything else refers to it:
 *
 * - `CONTENT_SECURITY_POLICY` - the full policy, delivered as a response header.
 *   This is the only form that can carry `frame-ancestors`.
 * - `META_CONTENT_SECURITY_POLICY` - the same minus `frame-ancestors`, for the
 *   <meta> tags in `src/renderer/index.html` and in generated print documents.
 *   Browsers ignore `frame-ancestors` in a meta tag and warn about it.
 * - `DEV_CONTENT_SECURITY_POLICY` - what `vite dev` and the dev-mode response
 *   header use. The dev server needs its HMR websocket and serves the React
 *   Fast Refresh preamble as an inline script; the strict policy would refuse
 *   both and leave the developer with no hot reload.
 *
 * `tests/csp.test.ts` asserts that the meta tag in `index.html` still matches
 * `META_CONTENT_SECURITY_POLICY`, so the three cannot drift apart.
 */

/**
 * Directives every delivery shares.
 *
 * 'unsafe-inline' appears for styles only, since Tailwind injects a stylesheet
 * and inline style attributes carry the meter widths and chart geometry.
 */
const BASE_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
];

/**
 * The shipping policy, for a response header.
 *
 * No remote origins are permitted at all: this app is fully offline, so any
 * attempt to load a remote script is a bug or an attack.
 */
export const CONTENT_SECURITY_POLICY = [...BASE_DIRECTIVES, "frame-ancestors 'none'"].join("; ");

/** The same policy minus `frame-ancestors`, for delivery inside a <meta> tag. */
export const META_CONTENT_SECURITY_POLICY = BASE_DIRECTIVES.join("; ");

/**
 * The relaxed policy used only while the dev server is running.
 *
 * `connect-src` names the dev server's websocket, because the page is served
 * from `http://localhost:5273` while the HMR client dials `ws://localhost:5273`
 * - a different scheme, so 'self' does not cover it.
 */
export const DEV_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  // The React plugin injects its Fast Refresh preamble as an inline script.
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' ws://localhost:5273 ws://127.0.0.1:5273",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");
