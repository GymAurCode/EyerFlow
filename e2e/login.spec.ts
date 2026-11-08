import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  COMPANY_NAME,
  completeSetup,
  fillByLabel,
  launchApp,
  type TestApp,
} from "./app";

/**
 * Wait for the sign-in screen's entrance to finish.
 *
 * The two panels arrive with a short movement, and anything measured while
 * that is still playing measures the movement rather than the layout.
 */
async function waitForEntrance(page: Page): Promise<void> {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"));
}

/**
 * First run and authentication.
 *
 * The gate order (setup -> login -> shell) is the thing most likely to break
 * silently, and a broken gate locks the shop out of their own data, so it is
 * worth its own file.
 */

let testApp: TestApp;

test.afterEach(async () => {
  await testApp?.close();
});

test("first run shows the setup wizard, not the login screen", async () => {
  testApp = await launchApp();

  await expect(testApp.window.getByText("Create administrator account")).toBeVisible();
  await expect(testApp.window.getByRole("button", { name: /^sign in$/i })).toHaveCount(0);
});

test("setup creates the administrator and signs them straight in", async () => {
  testApp = await launchApp();

  await completeSetup(testApp.window);

  // The dashboard confirms both that setup finished and that the session is
  // live. Its KPI tiles are the next thing to check they render.
  await expect(testApp.window.getByRole("heading", { name: "Dashboard" }).last()).toBeVisible();
  await expect(testApp.window.getByText("Sales Today").first()).toBeVisible();
});

test("setup rejects a password that breaks the policy", async () => {
  testApp = await launchApp();

  await testApp.window.getByText("Create administrator account").waitFor();

  await fillByLabel(testApp.window, /company name/i, COMPANY_NAME);
  await fillByLabel(testApp.window, /your name/i, "Test Administrator");
  await fillByLabel(testApp.window, /^username/i, ADMIN_USERNAME);
  await fillByLabel(testApp.window, /^password/i, "weak");

  await testApp.window.getByRole("button", { name: /finish setup/i }).click();

  // The field's own hint mentions the rule at all times, so this asserts on
  // the rejection itself: an alert, and the wizard still standing.
  await expect(testApp.window.getByRole("alert")).toBeVisible();
  await expect(testApp.window.getByText("Create administrator account")).toBeVisible();
});

test("signs in with valid credentials and rejects a wrong password", async () => {
  testApp = await launchApp();
  await completeSetup(testApp.window);

  // Sign out through the sidebar footer, the way a user does it.
  await testApp.window
    .getByRole("button", { name: /sign out|log out/i })
    .first()
    .click();
  await testApp.window.getByRole("button", { name: /^sign in$/i }).waitFor({ timeout: 20_000 });

  await fillByLabel(testApp.window, /username/i, ADMIN_USERNAME);
  await fillByLabel(testApp.window, /password/i, "definitely-not-the-password");
  await testApp.window.getByRole("button", { name: /^sign in$/i }).click();

  await expect(testApp.window.getByText(/incorrect|invalid|wrong/i).first()).toBeVisible();

  await fillByLabel(testApp.window, /username/i, ADMIN_USERNAME);
  await fillByLabel(testApp.window, /password/i, ADMIN_PASSWORD);
  await testApp.window.getByRole("button", { name: /^sign in$/i }).click();

  await expect(testApp.window.getByRole("heading", { name: "Dashboard" }).last()).toBeVisible({
    timeout: 20_000,
  });
});

test("shows the brand half of the split and reveals the password on request", async () => {
  testApp = await launchApp();
  await completeSetup(testApp.window);

  await testApp.window
    .getByRole("button", { name: /sign out|log out/i })
    .first()
    .click();
  await testApp.window.getByRole("button", { name: /^sign in$/i }).waitFor({ timeout: 20_000 });

  // Eyercall's side of the split: the mark, the company name, the headline,
  // the three things the product does and the credit at the foot.
  await expect(testApp.window.getByText("Eyercall").first()).toBeVisible();
  await expect(testApp.window.getByText("Smarter Inventory.")).toBeVisible();
  await expect(testApp.window.getByText("Inventory & Stock Control")).toBeVisible();
  await expect(testApp.window.getByText("Sales & Purchase Management")).toBeVisible();
  await expect(testApp.window.getByText("Financial Insights & Reporting")).toBeVisible();
  await expect(testApp.window.getByText("Powered by")).toBeVisible();

  // The form's side.
  await expect(testApp.window.getByRole("heading", { name: "Welcome back" })).toBeVisible();

  // The toggle reveals the password and puts it back.
  const password = testApp.window.getByLabel(/password/i);
  await expect(password).toHaveAttribute("type", "password");
  await testApp.window.getByRole("button", { name: "Show password" }).click();
  await expect(password).toHaveAttribute("type", "text");
  await testApp.window.getByRole("button", { name: "Hide password" }).click();
  await expect(password).toHaveAttribute("type", "password");
});

test("a rejected sign-in shows its message without moving the button", async () => {
  testApp = await launchApp();
  await completeSetup(testApp.window);

  await testApp.window
    .getByRole("button", { name: /sign out|log out/i })
    .first()
    .click();
  await testApp.window.getByRole("button", { name: /^sign in$/i }).waitFor({ timeout: 20_000 });

  const signIn = testApp.window.getByRole("button", { name: /^sign in$/i });
  await waitForEntrance(testApp.window);
  const before = await signIn.boundingBox();

  await fillByLabel(testApp.window, /username/i, ADMIN_USERNAME);
  await fillByLabel(testApp.window, /password/i, "definitely-not-the-password");
  await signIn.click();

  await expect(testApp.window.getByText(/incorrect|invalid|wrong/i).first()).toBeVisible();

  // The message has a reserved home, so the button is exactly where it was.
  const after = await signIn.boundingBox();
  expect(after?.y).toBe(before?.y);
});

test("locks the account after repeated wrong passwords", async () => {
  testApp = await launchApp();
  await completeSetup(testApp.window);

  await testApp.window
    .getByRole("button", { name: /sign out|log out/i })
    .first()
    .click();
  await testApp.window.getByRole("button", { name: /^sign in$/i }).waitFor({ timeout: 20_000 });

  // The policy is five consecutive failures before the account locks.
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await fillByLabel(testApp.window, /username/i, ADMIN_USERNAME);
    await fillByLabel(testApp.window, /password/i, `wrong-password-${String(attempt)}`);
    await testApp.window.getByRole("button", { name: /^sign in$/i }).click();
    await testApp.window.waitForTimeout(700);
  }

  await expect(testApp.window.getByText(/too many wrong attempts/i).first()).toBeVisible();

  // The correct password is refused while the lock stands.
  await fillByLabel(testApp.window, /username/i, ADMIN_USERNAME);
  await fillByLabel(testApp.window, /password/i, ADMIN_PASSWORD);
  await testApp.window.getByRole("button", { name: /^sign in$/i }).click();
  await expect(testApp.window.getByText(/too many wrong attempts|locked/i).first()).toBeVisible();
});
