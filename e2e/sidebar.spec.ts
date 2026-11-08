import { expect, test } from "@playwright/test";
import { completeSetup, launchApp, waitForDashboard, type TestApp } from "./app";

/**
 * The navigation rail: the vendor credit, and the collapse transition.
 *
 * Measured rather than eyeballed. "Smooth" is asserted as the largest movement
 * of the logo and the icons between two consecutive animation frames, because
 * that is the thing a jump actually is.
 */
test.describe("sidebar", () => {
  let testApp: TestApp;

  test.beforeEach(async () => {
    testApp = await launchApp();
    await completeSetup(testApp.window);
    await waitForDashboard(testApp.window);
  });

  test.afterEach(async () => {
    await testApp.close();
  });

  test("shows the vendor credit at the bottom of the expanded rail", async () => {
    const page = testApp.window;
    const rail = page.getByRole("complementary", { name: "Main navigation" });

    await expect(rail.getByText("Powered by")).toBeVisible();
    await expect(rail.getByText("Eyercall")).toBeVisible();

    // Bottom of the rail, not floating in the middle of the page: the credit's
    // box has to sit below the nav and be inside the rail's own bounds.
    const box = (await rail.getByText("Powered by").boundingBox()) as {
      x: number;
      y: number;
    };
    const railBox = (await rail.boundingBox()) as { height: number };
    expect(box.y).toBeGreaterThan(railBox.height * 0.8);

    // Centred across the rail.
    const credit = (await rail.getByText("Eyercall").boundingBox()) as {
      x: number;
      width: number;
    };
    const inner = (await rail.boundingBox()) as { x: number; width: number };
    const creditCentre = credit.x + credit.width / 2;
    const railCentre = inner.x + inner.width / 2;
    expect(Math.abs(creditCentre - railCentre)).toBeLessThan(3);
  });

  test("hides the credit when collapsed, without leaving a stray box", async () => {
    const page = testApp.window;
    const rail = page.getByRole("complementary", { name: "Main navigation" });

    await page.getByRole("button", { name: "Collapse menu" }).click();
    await page.waitForTimeout(600);

    await expect(rail.getByText("Powered by")).toBeHidden();

    // The rail must not have grown to accommodate hidden text, and nothing may
    // overflow its width.
    const overflow = await page.evaluate(() => {
      const aside = document.querySelector("aside[aria-label='Main navigation']") as HTMLElement;
      const panel = aside.querySelector(".glass-sidebar") as HTMLElement;
      return {
        panelScrollW: panel.scrollWidth,
        panelClientW: panel.clientWidth,
        railScrollH: aside.scrollHeight,
        railClientH: aside.clientHeight,
      };
    });
    expect(overflow.panelScrollW).toBeLessThanOrEqual(overflow.panelClientW);
    expect(overflow.railScrollH).toBeLessThanOrEqual(overflow.railClientH);
  });

  test("centres the logo exactly in the collapsed rail", async () => {
    const page = testApp.window;

    await page.getByRole("button", { name: "Collapse menu" }).click();
    await page.waitForTimeout(600);

    const measure = await page.evaluate(() => {
      const panel = document.querySelector(".glass-sidebar") as HTMLElement;
      const logo = panel.querySelector("img") as HTMLImageElement;
      const p = panel.getBoundingClientRect();
      const l = logo.getBoundingClientRect();
      return {
        offset: (l.x + l.width / 2) - (p.x + p.width / 2),
        width: l.width,
        height: l.height,
        top: l.y,
      };
    });

    // Within a pixel: the mark is centred by the layout, not by an offset that
    // happens to look right at one window size.
    expect(Math.abs(measure.offset)).toBeLessThan(1);
    // And it kept its size and vertical position. Compared approximately: the
    // browser lays this out on subpixels and returns 35.99 for a 36px box.
    expect(measure.width).toBeCloseTo(36, 1);
    expect(measure.height).toBeCloseTo(36, 1);
    expect(measure.top).toBeCloseTo(33, 0);
  });

  test("collapses without a jump and leaves the page edge in step", async () => {
    const page = testApp.window;

    const result = await page.evaluate(async () => {
      const sleep = (ms: number): Promise<void> =>
        new Promise((r) => {
          setTimeout(r, ms);
        });

      const panel = document.querySelector(".glass-sidebar") as HTMLElement;
      const logo = panel.querySelector("img") as HTMLImageElement;
      const row = panel.querySelector("nav a") as HTMLElement;
      const icon = row.querySelector("svg") as SVGElement;
      const main = document.querySelector("main") as HTMLElement;

      const sample = () => {
        const lr = logo.getBoundingClientRect();
        const ir = icon.getBoundingClientRect();
        const mr = main.getBoundingClientRect();
        // getBoundingClientRect, not clientWidth: the panel carries a 1px
        // border, so its content box is 58px when the rail is 60px wide.
        return { logoX: lr.x, iconX: ir.x, panelW: panel.getBoundingClientRect().width, mainX: mr.x };
      };

      const samples: ReturnType<typeof sample>[] = [];
      const toggle = document.querySelector(
        'button[aria-label="Collapse menu"]',
      ) as HTMLElement;
      toggle.click();

      const t0 = performance.now();
      while (performance.now() - t0 < 600) {
        samples.push(sample());
        await new Promise((r) => requestAnimationFrame(r));
      }
      await sleep(400);
      samples.push(sample());

      let maxLogoStep = 0;
      let maxIconStep = 0;
      let maxSeam = 0;
      for (let i = 1; i < samples.length; i++) {
        maxLogoStep = Math.max(maxLogoStep, Math.abs(samples[i]!.logoX - samples[i - 1]!.logoX));
        maxIconStep = Math.max(maxIconStep, Math.abs(samples[i]!.iconX - samples[i - 1]!.iconX));
        // The page edge should always be flush with the rail, never ahead of
        // it and never overlapping it.
        maxSeam = Math.max(maxSeam, Math.abs(samples[i]!.mainX - (samples[i]!.panelW + 32)));
      }

      const xs = samples.map((s) => s.iconX);
      const ls = samples.map((s) => s.logoX);

      return {
        frames: samples.length,
        maxLogoStep: +maxLogoStep.toFixed(2),
        maxIconStep: +maxIconStep.toFixed(2),
        maxSeamError: +maxSeam.toFixed(2),
        totalIconTravel: +(Math.max(...xs) - Math.min(...xs)).toFixed(2),
        totalLogoTravel: +(Math.max(...ls) - Math.min(...ls)).toFixed(2),
        finalPanelW: samples[samples.length - 1]!.panelW,
      };
    });

    console.error("collapse measurement:", JSON.stringify(result));

    // The regression this guards is the old behaviour: the row switched to
    // `justify-center` the instant the button was pressed, which teleported the
    // icon roughly 96px sideways on the first frame. Total travel is therefore
    // the meaningful number - it was ~96px before and is a few px now.
    expect(result.totalIconTravel).toBeLessThan(12);
    expect(result.totalLogoTravel).toBeLessThan(12);
    // And no single frame carries more than that small travel on its own.
    expect(result.maxIconStep).toBeLessThan(8);
    expect(result.maxLogoStep).toBeLessThan(8);
    // The page edge tracks the rail throughout, not only at the end.
    expect(result.maxSeamError).toBeLessThan(2);
    expect(result.finalPanelW).toBeCloseTo(60, 1);
  });

  test("survives repeated toggling and keeps the active route", async () => {
    const page = testApp.window;

    await page.getByRole("link", { name: /^sales$/i }).first().click();
    await page.waitForTimeout(500);

    for (let i = 0; i < 10; i++) {
      const collapse = page.getByRole("button", { name: "Collapse menu" });
      const expand = page.getByRole("button", { name: "Expand menu" });
      await (i % 2 === 0 ? collapse : expand).click();
      await page.waitForTimeout(60);
    }
    // Long enough for the last transition to finish before reading the geometry.
    await page.waitForTimeout(900);

    // Still on Sales, and the active pill is still lit.
    await expect(page.getByRole("heading", { name: "Sales" }).last()).toBeVisible();
    const active = page.locator('nav a[aria-current="page"]');
    await expect(active).toHaveCount(1);
    await expect(active).toHaveText(/sales/i);

    // Ten toggles alternating, ending expanded, must leave it usable.
    await expect(page.locator(".glass-sidebar")).toHaveJSProperty("clientWidth", 250);

    // And it can still be driven to a correct collapsed state afterwards.
    await page.getByRole("button", { name: "Collapse menu" }).click();
    await page.waitForTimeout(700);

    const logo = await page.evaluate(() => {
      const panel = document.querySelector(".glass-sidebar") as HTMLElement;
      const l = (panel.querySelector("img") as HTMLImageElement).getBoundingClientRect();
      const p = panel.getBoundingClientRect();
      return { offset: (l.x + l.width / 2) - (p.x + p.width / 2), panelW: p.width };
    });
    expect(logo.panelW).toBeCloseTo(60, 1);
    expect(Math.abs(logo.offset)).toBeLessThan(1);
  });

  test("respects reduced motion", async () => {
    const page = testApp.window;

    // The base layer already collapses animation durations under this
    // preference; this checks the rail does not end up somewhere wrong because
    // of it.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Collapse menu" }).click();
    await page.waitForTimeout(300);

    const logo = await page.evaluate(() => {
      const panel = document.querySelector(".glass-sidebar") as HTMLElement;
      const l = (panel.querySelector("img") as HTMLImageElement).getBoundingClientRect();
      const p = panel.getBoundingClientRect();
      return { offset: (l.x + l.width / 2) - (p.x + p.width / 2), panelW: p.width };
    });
    expect(logo.panelW).toBeCloseTo(60, 1);
    expect(Math.abs(logo.offset)).toBeLessThan(1);
  });
});
