import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  completeSetup,
  fillByLabel,
  launchApp,
  type TestApp,
} from "./app";

/**
 * The login screen's forgotten-password flow.
 *
 * Password checking, the EyerCall codes and the lockout rules are covered
 * against the real main-process code in `tests/password-recovery.test.ts`.
 * These tests cover the customer-facing part: the button is on the login
 * screen, the dialog points to EyerCall instead of printing the codes, and a
 * reset actually changes the password that signs in.
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

async function fillIn(scope: Locator, label: RegExp, value: string): Promise<void> {
  const field = scope.getByLabel(label).first();
  await field.waitFor({ state: "visible", timeout: 20_000 });
  await field.fill(value);
}

async function openForgotPassword(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: /forgot password/i }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

async function resetWith(dialog: Locator, code: string, newPassword: string): Promise<void> {
  await fillIn(dialog, /^username/i, ADMIN_USERNAME);
  await fillIn(dialog, /secret code/i, code);
  await fillIn(dialog, /^new password/i, newPassword);
  await fillIn(dialog, /confirm new password/i, newPassword);
  await dialog.getByRole("button", { name: /reset password/i }).click();
}

test("points to EyerCall for the code and accepts both codes", async () => {
  testApp = await launchApp();
  await completeSetup(testApp.window);
  await signOut(testApp.window);

  let dialog = await openForgotPassword(testApp.window);
  await expect(dialog.getByText(/get your secret code from eyercall/i)).toBeVisible();
  await expect(dialog.getByText(/contact eyercall support/i)).toBeVisible();

  // The customer is told where to get a code; the codes themselves are not
  // printed in the renderer.
  await expect(dialog.getByText("UMX", { exact: true })).toHaveCount(0);
  await expect(dialog.getByText("EYER-CALL", { exact: true })).toHaveCount(0);

  await resetWith(dialog, "UMX", "Recovered123");
  await expect(testApp.window.getByText(/password reset/i).first()).toBeVisible();

  // The old password is gone and the new one signs in.
  await fillByLabel(testApp.window, /username/i, ADMIN_USERNAME);
  await fillByLabel(testApp.window, /password/i, ADMIN_PASSWORD);
  await testApp.window.getByRole("button", { name: /^sign in$/i }).click();
  await expect(testApp.window.getByText(/incorrect|invalid|wrong/i).first()).toBeVisible();

  await fillByLabel(testApp.window, /password/i, "Recovered123");
  await testApp.window.getByRole("button", { name: /^sign in$/i }).click();
  await testApp.window.getByRole("navigation").first().waitFor({ timeout: 20_000 });

  // The second code works from the same screen.
  await signOut(testApp.window);
  dialog = await openForgotPassword(testApp.window);
  await resetWith(dialog, "EYER-CALL", "Recovered456");
  await expect(testApp.window.getByText(/password reset/i).first()).toBeVisible();

  await fillByLabel(testApp.window, /password/i, "Recovered456");
  await testApp.window.getByRole("button", { name: /^sign in$/i }).click();
  await testApp.window.getByRole("navigation").first().waitFor({ timeout: 20_000 });
});

test("a wrong code shows an error and leaves the old password working", async () => {
  testApp = await launchApp();
  await completeSetup(testApp.window);
  await signOut(testApp.window);

  const dialog = await openForgotPassword(testApp.window);
  await resetWith(dialog, "not-the-code", "Recovered123");

  await expect(dialog.getByRole("alert").first()).toContainText(
    /username or secret code is not valid/i,
  );
  await expect(dialog).toBeVisible();

  await dialog.getByRole("button", { name: /cancel/i }).click();
  await fillByLabel(testApp.window, /username/i, ADMIN_USERNAME);
  await fillByLabel(testApp.window, /password/i, ADMIN_PASSWORD);
  await testApp.window.getByRole("button", { name: /^sign in$/i }).click();
  await testApp.window.getByRole("navigation").first().waitFor({ timeout: 20_000 });
});
