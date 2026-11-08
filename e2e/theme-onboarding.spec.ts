import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { completeSetup, launchApp, rpc, type TestApp } from "./app";

/**
 * The first-login theme chooser.
 *
 * The important properties are not visual: choosing a card must not change the
 * stored palette, Preview must paint the candidate on the real application,
 * Back must put the old one back, and Done must persist the choice and stay
 * gone on the next visit. The login-screen half of the request is checked by
 * comparing the brand panel's rendered background with the palette's rail.
 */

let testApp: TestApp;

test.afterEach(async () => {
  await testApp?.close();
});

const paletteOf = (page: Page): Promise<string | null> =>
  page.evaluate(() => document.documentElement.getAttribute("data-palette"));

test("preview is temporary, Back restores, Done persists and themes the login panel", async () => {
  testApp = await launchApp();
  const page = testApp.window;

  // Keep the chooser open: this test is about driving it.
  await completeSetup(page, { skipThemeOnboarding: false });

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Choose your theme" })).toBeVisible();

  // Selecting a card is only a selection at this point.
  await dialog.getByRole("button", { name: /^Burgundy Wine/ }).click();
  expect(await paletteOf(page)).toBe("ocean-teal");

  await dialog.getByRole("button", { name: /^Preview Burgundy Wine$/i }).click();

  const previewBar = page.getByRole("region", { name: "Theme preview" });
  await expect(previewBar).toBeVisible();
  await expect(previewBar.getByText(/Previewing Burgundy Wine/)).toBeVisible();
  await expect.poll(() => paletteOf(page)).toBe("burgundy-wine");

  // Back is the promise that an abandoned preview changes nothing.
  await previewBar.getByRole("button", { name: /^Back$/ }).click();
  await expect(dialog.getByRole("heading", { name: "Choose your theme" })).toBeVisible();
  await expect.poll(() => paletteOf(page)).toBe("ocean-teal");

  // A different pack, then Done, is the one path that writes.
  await dialog.getByRole("button", { name: /^Sage Green/ }).click();
  await dialog.getByRole("button", { name: /^Preview Sage Green$/i }).click();
  await expect.poll(() => paletteOf(page)).toBe("sage-green");

  await page
    .getByRole("region", { name: "Theme preview" })
    .getByRole("button", { name: /^Done$/ })
    .click();
  await expect(page.getByRole("region", { name: "Theme preview" })).toHaveCount(0);
  await expect.poll(() => paletteOf(page)).toBe("sage-green");

  const settings = await rpc<{ themePalette: string; themeOnboardingComplete: boolean }>(
    page,
    "settings.get",
  );
  expect(settings.themePalette).toBe("sage-green");
  expect(settings.themeOnboardingComplete).toBe(true);

  // The chooser does not come back for a later sign-in on this installation.
  await page
    .getByRole("button", { name: /sign out|log out/i })
    .first()
    .click();
  await page.getByRole("button", { name: /^sign in$/i }).waitFor({ timeout: 20_000 });
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // The brand half of the login split uses the same rail colour as the pack
  // instead of the old fixed teal.
  const colours = await page.evaluate(() => {
    const panel = document.querySelector(".auth-panel");
    if (!(panel instanceof HTMLElement)) return null;

    const probe = document.createElement("span");
    probe.style.backgroundColor = "var(--sidebar-bg)";
    document.body.appendChild(probe);

    const result = {
      panel: getComputedStyle(panel).backgroundColor,
      sidebar: getComputedStyle(probe).backgroundColor,
      palette: document.documentElement.getAttribute("data-palette"),
    };
    probe.remove();
    return result;
  });

  expect(colours).not.toBeNull();
  expect(colours?.palette).toBe("sage-green");
  expect(colours?.panel).toBe(colours?.sidebar);
});
