import { expect, test } from "@playwright/test";
import {
  completeSetup,
  createTestDataDir,
  launchApp,
  removeTestDataDir,
  waitForDashboard,
  type TestApp,
} from "./app";

/**
 * Theme choice: applied now, and still there after a restart.
 *
 * The switch writes to the settings table and to the pre-paint hint in
 * localStorage. This test exercises both paths against the real application.
 */

test("the theme menu leads to the full theme catalogue", async () => {
  const dataDir = createTestDataDir();
  let testApp: TestApp | null = null;

  try {
    testApp = await launchApp(dataDir);
    const page = testApp.window;
    await completeSetup(page);
    await waitForDashboard(page);

    await page.getByRole("button", { name: /^Theme:/ }).click();
    const explore = page.getByRole("menuitem", { name: /Explore more themes/i });
    await expect(explore).toBeVisible();
    await explore.click();

    // The shortcut has to open Settings on the Appearance section, not merely
    // land on the Company tab where the themes are hidden.
    await expect(page).toHaveURL(/#\/settings\?tab=appearance$/);
    await expect(page.getByRole("heading", { name: /Appearance & Themes/i })).toBeVisible();
    await expect(
      page
        .getByRole("navigation", { name: /settings sections/i })
        .getByRole("button", { name: "Appearance", exact: true }),
    ).toHaveAttribute("aria-current", "page");
    await expect(page.getByText("15 of 15 themes shown.")).toBeVisible();
    await expect(page.getByRole("button", { name: /^Ocean Teal/ })).toBeVisible();
  } finally {
    if (testApp !== null) await testApp.close();
    removeTestDataDir(dataDir);
  }
});

test("theme applies immediately and survives a relaunch", async () => {
  const dataDir = createTestDataDir();
  let testApp: TestApp | null = null;

  try {
    testApp = await launchApp(dataDir);
    const page = testApp.window;
    await completeSetup(page);
    await waitForDashboard(page);

    const isDark = (): Promise<boolean> =>
      page.evaluate(() => document.documentElement.classList.contains("dark"));

    const choose = async (label: "Light" | "Dark"): Promise<void> => {
      await page.getByRole("button", { name: /^Theme:/ }).click();
      await page.getByRole("menuitemradio", { name: label }).click();
      // Radix unmounts the menu after its exit animation; waiting here keeps
      // the next trigger click from landing on the old menu.
      await page.waitForTimeout(250);
    };

    await choose("Light");
    await expect.poll(isDark).toBe(false);

    await choose("Dark");
    await expect.poll(isDark).toBe(true);

    await testApp.close();
    testApp = null;

    const relaunched = await launchApp(dataDir);
    testApp = relaunched;
    const reopened = relaunched.window;

    // A restart may land on the login screen or restore the session. Either is
    // fine: the theme is read before the shell is chosen.
    await Promise.race([
      reopened.getByRole("button", { name: /^sign in$/i }).waitFor({ timeout: 30_000 }),
      reopened.getByRole("navigation").first().waitFor({ timeout: 30_000 }),
    ]);

    // The settings read finishes after the window is up, so poll rather than
    // assume the first frame already has the stored class.
    await expect
      .poll(() => reopened.evaluate(() => document.documentElement.classList.contains("dark")))
      .toBe(true);
  } finally {
    if (testApp !== null) await testApp.close();
    removeTestDataDir(dataDir);
  }
});
