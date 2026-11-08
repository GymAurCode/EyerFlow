import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  COMPANY_NAME,
  completeSetup,
  fillByLabel,
  launchApp,
  rpc,
  type TestApp,
} from "./app";

/**
 * The two login-screen registration flows.
 *
 * The password checks, lockout and licence binding are covered against the
 * real RPC handlers in `tests/registration.test.ts`. These tests cover the part
 * that unit tests cannot: the options are hidden on first run, they appear on
 * the login screen, prefill from the existing records, and do not replace the
 * account that was already there.
 */

let testApp: TestApp;

test.afterEach(async () => {
  await testApp?.close();
});

async function signOut(page: Page): Promise<void> {
  await page
    .getByRole("button", { name: /sign out|log out/i })
    .first()
    .click();
  await page.getByRole("button", { name: /^sign in$/i }).waitFor({ timeout: 20_000 });
}

/** Fill a field inside a dialog, where the page has fields with similar labels. */
async function fillIn(scope: Locator, label: RegExp, value: string): Promise<void> {
  const field = scope.getByLabel(label).first();
  await field.waitFor({ state: "visible", timeout: 20_000 });
  await field.fill(value);
}

test("first run has no registration options; edit prefills and saves existing details", async () => {
  testApp = await launchApp();

  await expect(
    testApp.window.getByRole("button", { name: /edit registration details/i }),
  ).toHaveCount(0);

  await completeSetup(testApp.window);
  await signOut(testApp.window);

  await testApp.window
    .getByRole("button", { name: /edit registration details/i })
    .waitFor({ timeout: 20_000 });
  await testApp.window.getByRole("button", { name: /edit registration details/i }).click();

  const dialog = testApp.window.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await fillIn(dialog, /owner password/i, ADMIN_PASSWORD);
  await dialog.getByRole("button", { name: /show details/i }).click();

  // The form is prefilled from settings and the existing administrator row.
  await expect(dialog.getByLabel(/business name/i)).toHaveValue(COMPANY_NAME);
  await expect(dialog.getByLabel(/owner name/i)).toHaveValue("Test Administrator");

  await fillIn(dialog, /business name/i, "Blue Water Trading & Service");
  await fillIn(dialog, /owner phone/i, "+92 300 1234567");
  await dialog.getByRole("button", { name: /save details/i }).click();

  await expect(testApp.window.getByText(/registration details updated/i).first()).toBeVisible();

  // Signing in still works, and the business name changed in the same settings
  // record the rest of the app reads.
  await fillByLabel(testApp.window, /username/i, ADMIN_USERNAME);
  await fillByLabel(testApp.window, /password/i, ADMIN_PASSWORD);
  await testApp.window.getByRole("button", { name: /^sign in$/i }).click();
  await testApp.window.getByRole("navigation").first().waitFor({ timeout: 20_000 });

  const settings = await rpc<{ companyName: string }>(testApp.window, "settings.get");
  expect(settings.companyName).toBe("Blue Water Trading & Service");
});

test("a new account is additive, shares the same licence, and leaves the original login intact", async () => {
  testApp = await launchApp();
  await completeSetup(testApp.window);
  await signOut(testApp.window);

  await testApp.window
    .getByRole("button", { name: /create new account/i })
    .waitFor({ timeout: 20_000 });
  await testApp.window.getByRole("button", { name: /create new account/i }).click();

  const dialog = testApp.window.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/does not create or extend a licence/i)).toBeVisible();
  await expect(dialog.getByText(/same business database/i)).toBeVisible();

  await fillIn(dialog, /administrator password/i, ADMIN_PASSWORD);
  await fillIn(dialog, /^username/i, "cashier");
  await fillIn(dialog, /person's name/i, "Front Desk");
  await fillIn(dialog, /new account password/i, "Cashier123");
  await fillIn(dialog, /confirm password/i, "Cashier123");
  await dialog.getByRole("button", { name: /create account/i }).click();

  await expect(testApp.window.getByText(/account "cashier" was created/i)).toBeVisible();
  // The new login name is ready in the form, but no session has been started.
  const login = testApp.window.getByRole("main");
  await expect(login.getByLabel(/^username/i)).toHaveValue("cashier");

  await fillIn(login, /password/i, "Cashier123");
  await testApp.window.getByRole("button", { name: /^sign in$/i }).click();
  await testApp.window.getByRole("navigation").first().waitFor({ timeout: 20_000 });
  await expect(testApp.window.getByText("Front Desk").first()).toBeVisible();

  // The account that created it is still active and still signs in. No
  // business data was reset when the second account was added.
  await signOut(testApp.window);
  await fillByLabel(testApp.window, /username/i, ADMIN_USERNAME);
  await fillByLabel(testApp.window, /password/i, ADMIN_PASSWORD);
  await testApp.window.getByRole("button", { name: /^sign in$/i }).click();
  await testApp.window.getByRole("navigation").first().waitFor({ timeout: 20_000 });
  await expect(testApp.window.getByText("Test Administrator").first()).toBeVisible();
});
