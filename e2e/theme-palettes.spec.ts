/**
 * Every colour pack, in both modes, against the real application.
 *
 * Switching a class is easy to get wrong in a way unit tests cannot see: a
 * token that is defined but unreadable, or a pack whose dark block never
 * applies. This drives the actual Appearance screen, chooses each of the
 * fifteen packs in Light and Dark, and measures the rendered token values -
 * including the derived ones - for contrast. It then relaunches the app to
 * prove the pack, not just the mode, is restored before the window paints.
 */

import { expect, test } from "@playwright/test";
import { THEME_CATALOG } from "../src/shared/themes";
import {
  completeSetup,
  createTestDataDir,
  launchApp,
  openSettingsTab,
  removeTestDataDir,
  waitForDashboard,
  type TestApp,
} from "./app";

interface Failure {
  readonly theme: string;
  readonly mode: string;
  readonly token: string;
  readonly ratio: number;
}

test("all fifteen packs paint readably in light and dark, and survive a relaunch", async () => {
  test.setTimeout(180_000);

  const dataDir = createTestDataDir();
  let testApp: TestApp | null = null;

  try {
    testApp = await launchApp(dataDir);
    const page = testApp.window;
    await completeSetup(page);
    await waitForDashboard(page);

    await openSettingsTab(page, "Appearance");
    await expect(page.getByRole("heading", { name: /Appearance & Themes/i })).toBeVisible();

    const modeGroup = page.getByRole("group", { name: "Appearance mode" });

    const chooseMode = async (mode: "Light" | "Dark"): Promise<void> => {
      await modeGroup.getByRole("button", { name: mode, exact: true }).click();
      await expect
        .poll(() => page.evaluate(() => document.documentElement.dataset["theme"]))
        .toBe(mode.toLowerCase());
    };

    const audit = async (): Promise<Failure[]> =>
      page.evaluate(() => {
        const probe = document.createElement("div");
        probe.setAttribute("aria-hidden", "true");
        probe.style.position = "fixed";
        probe.style.inset = "0";
        probe.style.opacity = "0";
        probe.style.pointerEvents = "none";
        document.body.appendChild(probe);

        const colour = (token: string, property: "color" | "backgroundColor"): string => {
          probe.style[property] = `var(${token})`;
          const value = window.getComputedStyle(probe)[property];
          probe.style[property] = "";
          return value;
        };

        /**
         * Parse a computed colour into 0-255 channels.
         *
         * Chromium serialises the result of `color-mix()` as `color(srgb r g b)`
         * with 0-1 floats rather than the `rgb()` form a literal colour uses, so
         * both shapes have to be understood or every derived token reads as
         * black - which is exactly the kind of false pass/fail an audit must not
         * produce. Alpha is ignored: every pair measured here is opaque.
         */
        const channels = (value: string): [number, number, number] => {
          const srgb = /color\(srgb\s+([^)]+)\)/.exec(value);
          if (srgb !== null) {
            const parts = (srgb[1] as string).split(/[\s/]+/).filter((part) => part.length > 0);
            const channel = (index: number): number => Math.round(Number(parts[index] ?? 0) * 255);
            return [channel(0), channel(1), channel(2)];
          }

          const match = /rgba?\(([^)]+)\)/.exec(value);
          if (match === null) return [0, 0, 0];
          const parts = (match[1] as string).split(/[\s,/]+/).filter((part) => part.length > 0);
          const channel = (index: number): number => {
            const part = parts[index] ?? "0";
            const number = Number.parseFloat(part);
            return part.endsWith("%") ? Math.round((number / 100) * 255) : Math.round(number);
          };
          return [channel(0), channel(1), channel(2)];
        };

        const luminance = (value: string): number => {
          const [r, g, b] = channels(value).map((channel) => {
            const s = channel / 255;
            return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
          });
          return 0.2126 * (r as number) + 0.7152 * (g as number) + 0.0722 * (b as number);
        };

        const contrast = (foreground: string, background: string): number => {
          const a = luminance(foreground);
          const b = luminance(background);
          const [hi, lo] = a > b ? [a, b] : [b, a];
          return (hi + 0.05) / (lo + 0.05);
        };

        const surface = colour("--surface", "backgroundColor");
        const rail = colour("--sidebar-bg", "backgroundColor");
        const active = colour("--sidebar-active-bg", "backgroundColor");

        const pairs: { token: string; foreground: string; background: string; min: number }[] = [
          {
            token: "text",
            foreground: colour("--text", "color"),
            background: surface,
            min: 7,
          },
          {
            token: "text-3",
            foreground: colour("--text-3", "color"),
            background: surface,
            min: 4.5,
          },
          {
            token: "brand",
            foreground: colour("--brand", "color"),
            background: surface,
            min: 4.5,
          },
          {
            token: "on-brand",
            foreground: colour("--on-brand", "color"),
            background: colour("--brand", "backgroundColor"),
            min: 4.5,
          },
          {
            token: "sidebar-text",
            foreground: colour("--sidebar-text", "color"),
            background: rail,
            min: 7,
          },
          {
            token: "sidebar-active-fg",
            foreground: colour("--sidebar-active-fg", "color"),
            background: active,
            min: 4.5,
          },
          ...["--violet", "--cyan", "--teal", "--gold", "--info"].map((token) => ({
            token,
            foreground: colour(token, "color"),
            background: surface,
            min: 4.5,
          })),
        ];

        const failures = pairs
          .map((pair) => ({
            token: pair.token,
            ratio: contrast(pair.foreground, pair.background),
            min: pair.min,
          }))
          .filter((pair) => pair.ratio < pair.min)
          .map((pair) => ({
            theme: document.documentElement.dataset["palette"] ?? "?",
            mode: document.documentElement.dataset["theme"] ?? "?",
            token: pair.token,
            ratio: pair.ratio,
          }));

        probe.remove();
        return failures;
      });

    const failures: Failure[] = [];

    for (const theme of THEME_CATALOG) {
      const card = page.getByRole("button", { name: new RegExp(`^${theme.name}`) });

      for (const mode of ["Light", "Dark"] as const) {
        await chooseMode(mode);
        await card.click();

        await expect(card).toHaveAttribute("aria-pressed", "true");
        await expect
          .poll(() => page.evaluate(() => document.documentElement.dataset["palette"]))
          .toBe(theme.id);

        failures.push(...(await audit()));
      }
    }

    // All thirty combinations measured in one go, so a failure names the pack
    // and the exact token instead of stopping at the first unreadable colour.
    expect(failures).toEqual([]);

    // The tokens are global, but navigate the real routes with a deliberately
    // non-default dark pack: a screen that painted its own literal background
    // would show up here, and so would a crash from reading the theme context.
    await chooseMode("Dark");
    await page.getByRole("button", { name: /^Midnight Navy/ }).click();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset["palette"]))
      .toBe("midnight-navy");

    const routes = [
      { label: "Dashboard", hash: "#/" },
      { label: "Products", hash: "#/products" },
      { label: "Purchases", hash: "#/purchases" },
      { label: "Sales", hash: "#/sales" },
      { label: "Suppliers", hash: "#/suppliers" },
      { label: "Customers", hash: "#/customers" },
      { label: "Expenses", hash: "#/expenses" },
      { label: "Finance", hash: "#/finance" },
      { label: "Reports", hash: "#/reports" },
    ] as const;

    for (const route of routes) {
      await page
        .getByRole("link", { name: new RegExp(`^${route.label}$`, "i") })
        .first()
        .click();
      await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(route.hash);

      const painted = await page.evaluate(() => {
        const main = document.querySelector(".app-main");
        if (!(main instanceof HTMLElement)) return null;

        const probe = document.createElement("div");
        probe.style.backgroundColor = "var(--main-bg)";
        probe.style.color = "var(--text)";
        document.body.appendChild(probe);

        const expected = getComputedStyle(probe);
        const actual = getComputedStyle(main);
        const result = {
          background: actual.backgroundColor === expected.backgroundColor,
          text: actual.color === expected.color,
          palette: document.documentElement.dataset["palette"],
          mode: document.documentElement.dataset["theme"],
        };

        probe.remove();
        return result;
      });

      expect(painted, route.label).toEqual({
        background: true,
        text: true,
        palette: "midnight-navy",
        mode: "dark",
      });
    }

    // The panel itself, as a visual record: all fifteen mini-previews in each
    // mode. Kept as test artifacts, not committed screenshots.
    await openSettingsTab(page, "Appearance");
    await chooseMode("Light");
    await page.screenshot({ path: test.info().outputPath("appearance-light.png") });

    await chooseMode("Dark");
    await page.getByRole("button", { name: /^Sandstone/ }).click();
    await page.screenshot({ path: test.info().outputPath("appearance-dark.png") });

    // Persist the pack and the mode, then restart. Both have to come back
    // before the first usable frame, not after a late settings read.
    await testApp.close();
    testApp = null;

    const relaunched = await launchApp(dataDir);
    testApp = relaunched;
    const reopened = relaunched.window;

    await Promise.race([
      reopened.getByRole("button", { name: /^sign in$/i }).waitFor({ timeout: 30_000 }),
      reopened.getByRole("navigation").first().waitFor({ timeout: 30_000 }),
    ]);

    await expect
      .poll(() => reopened.evaluate(() => document.documentElement.dataset["palette"]))
      .toBe("sandstone");
    await expect
      .poll(() => reopened.evaluate(() => document.documentElement.classList.contains("dark")))
      .toBe(true);
  } finally {
    if (testApp !== null) await testApp.close();
    removeTestDataDir(dataDir);
  }
});
