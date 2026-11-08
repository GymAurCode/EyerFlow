/**
 * Content-Security-Policy guards.
 *
 * The policy is delivered three ways - as a response header, as a <meta> tag in
 * the renderer document, and (in dev) as a relaxed variant - and a policy that
 * only half-applies is worse than none, because it looks like it is working.
 *
 * Two real problems came out of that. The <meta> tag carried
 * `frame-ancestors`, which browsers ignore in a meta element and warn about,
 * so it defended nothing while making the console look broken. And the policy
 * shipped in that tag was applied verbatim to the dev server, where it refused
 * Vite's HMR websocket, so the app was running with no hot reload and no
 * obvious cause.
 *
 * These assertions pin the three deliveries to one source of truth.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONTENT_SECURITY_POLICY,
  DEV_CONTENT_SECURITY_POLICY,
  META_CONTENT_SECURITY_POLICY,
} from "../src/shared/content-security-policy";

const rendererHtml = readFileSync(join(process.cwd(), "src", "renderer", "index.html"), "utf8");

function metaTagPolicy(html: string): string {
  const match = /http-equiv="Content-Security-Policy"\s+content="([^"]*)"/i.exec(html);
  expect(match, "the renderer document must declare a CSP meta tag").not.toBeNull();
  return match?.[1] ?? "";
}

describe("the renderer meta tag", () => {
  it("carries exactly the meta policy from the shared module", () => {
    expect(metaTagPolicy(rendererHtml)).toBe(META_CONTENT_SECURITY_POLICY);
  });

  it("omits frame-ancestors, which a browser ignores in a meta tag", () => {
    expect(META_CONTENT_SECURITY_POLICY).not.toContain("frame-ancestors");
    // Checked on the tag's value, not the file: the comment beside it is allowed
    // to explain which directive was left out and why.
    expect(metaTagPolicy(rendererHtml)).not.toContain("frame-ancestors");
  });

  it("keeps the app offline: no remote origin is permitted", () => {
    expect(META_CONTENT_SECURITY_POLICY).toContain("default-src 'self'");
    expect(META_CONTENT_SECURITY_POLICY).toContain("connect-src 'none'");
    expect(META_CONTENT_SECURITY_POLICY).not.toMatch(/https?:\/\//);
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/https?:\/\//);
  });

  it("only allows inline styles, which Tailwind and the meters need", () => {
    expect(META_CONTENT_SECURITY_POLICY).toContain("style-src 'self' 'unsafe-inline'");
    expect(META_CONTENT_SECURITY_POLICY).toContain("script-src 'self'");
    expect(META_CONTENT_SECURITY_POLICY).not.toContain("script-src 'self' 'unsafe-inline'");
  });
});

describe("the header policy", () => {
  it("is the meta policy plus frame-ancestors, which only works as a header", () => {
    expect(CONTENT_SECURITY_POLICY).toBe(`${META_CONTENT_SECURITY_POLICY}; frame-ancestors 'none'`);
  });

  it("is actually installed on the session, before any document loads", () => {
    const mainSource = readFileSync(join(process.cwd(), "src", "main", "main.ts"), "utf8");
    const windowSource = readFileSync(join(process.cwd(), "src", "main", "window.ts"), "utf8");

    expect(mainSource).toMatch(/applyContentSecurityPolicy\(/);
    expect(windowSource).toMatch(/onHeadersReceived/);

    // It must run before the window loads anything.
    expect(mainSource.indexOf("applyContentSecurityPolicy(")).toBeLessThan(
      mainSource.indexOf("openWindow();"),
    );
  });
});

describe("the dev policy", () => {
  it("lets the HMR client reach the dev server's websocket", () => {
    // 'self' is the http origin; the HMR socket is ws://, which 'self' does not
    // cover, so the scheme has to be named.
    expect(DEV_CONTENT_SECURITY_POLICY).toContain("ws://localhost:5273");
  });

  it("allows the inline Fast Refresh preamble but nothing else remote", () => {
    expect(DEV_CONTENT_SECURITY_POLICY).toContain("script-src 'self' 'unsafe-inline'");
    expect(DEV_CONTENT_SECURITY_POLICY).not.toMatch(/https?:\/\//);
  });

  it("is swapped in only while serving, never in a production build", () => {
    const viteConfig = readFileSync(join(process.cwd(), "vite.config.ts"), "utf8");

    expect(viteConfig).toMatch(/apply:\s*"serve"/);
    expect(viteConfig).toMatch(/DEV_CONTENT_SECURITY_POLICY/);
  });
});
