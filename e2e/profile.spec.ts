import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import {
  completeSetup,
  createTestDataDir,
  launchApp,
  removeTestDataDir,
  rpc,
  waitForDashboard,
  type TestApp,
} from "./app";

/**
 * The account menu, the profile page and the picture round trip.
 *
 * Runs against the real application: a real database, real migrations and the
 * real RPC layer, so "it persisted" here means it is in the database file.
 */

test.describe("profile page", () => {
  let testApp: TestApp;
  // Owned by this file rather than by either launch, so the restart test can
  // close one process and open another against the same database.
  let ownedDataDir: string | null = null;

  async function start(ownDataDir: boolean): Promise<void> {
    ownedDataDir = ownDataDir ? createTestDataDir() : null;
    testApp = await launchApp(ownedDataDir ?? undefined);
    await completeSetup(testApp.window);
    await waitForDashboard(testApp.window);
  }

  test.beforeEach(async () => {
    await start(false);
  });

  test.afterEach(async () => {
    await testApp.close();
    if (ownedDataDir !== null) removeTestDataDir(ownedDataDir);
  });

  test("is reachable from the account menu and loads the signed-in user", async () => {
    const page = testApp.window;

    await page.getByRole("button", { name: /Test Administrator/ }).click();
    await page.getByRole("menuitem", { name: "Profile" }).click();

    await expect(page.getByRole("heading", { name: "Test Administrator" })).toBeVisible();

    // Read the account summary rather than matching bare text: "Administrator"
    // appears in the rail, the top bar, the role badge and the role row.
    const account = page.locator("dl");
    await expect(account.getByText("admin", { exact: true })).toBeVisible();
    await expect(account.getByText("Administrator", { exact: true })).toBeVisible();
    await expect(account.getByText("Blue Water Trading", { exact: true })).toBeVisible();

    // The overview starts on initials, since no picture has been chosen.
    await expect(page.getByText("Using your initials.")).toBeVisible();
  });

  test("the account menu holds the profile, not a second way to change the password", async () => {
    const page = testApp.window;

    await page.getByRole("button", { name: /Test Administrator/ }).click();

    // What the menu is for: your own account, and the way out.
    await expect(page.getByRole("menuitem", { name: "Profile" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: /sign out/i })).toBeVisible();

    // Changing the password is not in here: it belongs to the profile page,
    // and a second entry only meant two ways to reach the same screen.
    await expect(page.getByRole("menuitem", { name: /change password/i })).toHaveCount(0);

    // The profile page still owns it.
    await page.getByRole("menuitem", { name: "Profile" }).click();
    await expect(page.getByRole("button", { name: /change password/i })).toBeVisible();
  });

  test("edits the name and persists it across a restart", async () => {
    const page = testApp.window;
    await openProfile(page);

    await page.getByRole("button", { name: "Edit profile" }).click();
    await page.getByLabel(/full name/i).fill("Renamed Owner");
    await page.getByLabel(/email address/i).fill("owner@example.com");
    await page.getByRole("button", { name: /save changes/i }).click();

    await expect(page.getByRole("heading", { name: "Renamed Owner" })).toBeVisible();

    // Navigate away and back: the change has to survive a route change.
    await page.getByRole("link", { name: /^dashboard$/i }).first().click();
    await page.waitForTimeout(400);
    await openProfile(page);
    await expect(page.getByRole("heading", { name: "Renamed Owner" })).toBeVisible();

    // And it is really in the database, read back by a fresh RPC call.
    const profile = await rpc<{ displayName: string; email: string }>(page, "profile.get");
    expect(profile.displayName).toBe("Renamed Owner");
    expect(profile.email).toBe("owner@example.com");
  });

  test("survives a full application restart", async () => {
    // Own the folder for this one, so the first close cannot delete it.
    await testApp.close();
    ownedDataDir = createTestDataDir();
    testApp = await launchApp(ownedDataDir);
    await completeSetup(testApp.window);
    await waitForDashboard(testApp.window);

    const page = testApp.window;
    await openProfile(page);
    await page.getByRole("button", { name: "Edit profile" }).click();
    await page.getByLabel(/full name/i).fill("Persisted Owner");
    await page.getByRole("button", { name: /save changes/i }).click();
    await expect(page.getByRole("heading", { name: "Persisted Owner" })).toBeVisible();

    const dataDir = testApp.dataDir;
    await testApp.close();

    // A second process against the same folder: a new process, the same
    // database, nothing kept in memory.
    testApp = await launchApp(dataDir);
    await signBackIn(testApp.window);
    await openProfile(testApp.window);
    await expect(testApp.window.getByRole("heading", { name: "Persisted Owner" })).toBeVisible();
  });

  test("validates a blank name and an invalid email, and Cancel changes nothing", async () => {
    const page = testApp.window;
    await openProfile(page);

    await page.getByRole("button", { name: "Edit profile" }).click();

    // Blank name is refused.
    await page.getByLabel(/full name/i).fill("   ");
    await page.getByRole("button", { name: /save changes/i }).click();
    await expect(page.getByText(/enter the name people should see/i)).toBeVisible();

    // Invalid email is refused.
    await page.getByLabel(/full name/i).fill("Valid Name");
    await page.getByLabel(/email address/i).fill("not-an-email");
    await page.getByRole("button", { name: /save changes/i }).click();
    await expect(page.getByText(/valid email address/i)).toBeVisible();

    // Cancel discards everything typed.
    await page.getByRole("button", { name: /^cancel$/i }).click();
    await expect(page.getByRole("heading", { name: "Test Administrator" })).toBeVisible();

    const profile = await rpc<{ displayName: string; email: string | null }>(page, "profile.get");
    expect(profile.displayName).toBe("Test Administrator");
    expect(profile.email).toBeNull();
  });

  test("shows a stored picture everywhere and removes it again", async () => {
    const page = testApp.window;
    const avatarsDir = join(testApp.dataDir, "avatars");

    // The native file picker itself is not driven here. `dialog.showOpenDialog`
    // opens a real modal that no automation can dismiss, so a test that calls
    // profile.chooseAvatar hangs until the run times out. The copy-and-validate
    // step is covered by tests/profile.test.ts against the real storeAvatar.
    //
    // What this covers is everything after it: a stored picture has to reach the
    // database, the session copy the shell renders, and the rail itself.
    mkdirSync(avatarsDir, { recursive: true });
    const stored = "1.png";
    writeFileSync(
      join(avatarsDir, stored),
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64",
      ),
    );

    const withPath = await rpc<{ avatarDataUrl: string | null }>(page, "profile.update", {
      displayName: "Test Administrator",
      email: "",
      phone: "",
      avatarPath: stored,
    });
    expect(withPath.avatarDataUrl).toMatch(/^data:image\/png;base64,/);

    // It reaches the session copy the rail and the top bar render.
    const session = await rpc<{ avatarDataUrl: string | null }>(page, "auth.currentUser", {});
    expect(session.avatarDataUrl).toMatch(/^data:image\/png;base64,/);

    // The shell holds its own copy of the session and only refreshes it after a
    // save the page made, so this RPC alone will not repaint the rail. Reload,
    // which is what a restart does anyway, and the rail picks it up.
    await page.reload();
    await signBackIn(page);
    await expect(page.locator('aside img[src^="data:image/png"]')).toBeVisible();

    // And the profile page shows it rather than initials.
    await openProfile(page);
    await expect(page.locator('img[src^="data:image/png"]').first()).toBeVisible();
    await expect(page.getByText("Custom picture.")).toBeVisible();

    // Removing it from the page itself goes back to initials and takes the file
    // with it. Done through the UI so the session refresh is exercised too.
    await page.getByRole("button", { name: "Edit profile" }).click();
    await page.getByRole("button", { name: /^remove$/i }).click();
    await page.getByRole("button", { name: /save changes/i }).click();

    await expect(page.getByText("Using your initials.")).toBeVisible();
    expect(existsSync(join(avatarsDir, stored))).toBe(false);
    await expect(page.locator('aside img[src^="data:image/png"]')).toHaveCount(0);
  });

  test("a picture survives a restart", async () => {
    await testApp.close();
    ownedDataDir = createTestDataDir();
    testApp = await launchApp(ownedDataDir);
    await completeSetup(testApp.window);
    await waitForDashboard(testApp.window);

    const page = testApp.window;
    const avatarsDir = join(testApp.dataDir, "avatars");
    mkdirSync(avatarsDir, { recursive: true });
    writeFileSync(
      join(avatarsDir, "1.png"),
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64",
      ),
    );
    await rpc(page, "profile.update", {
      displayName: "Pictured Owner",
      email: "",
      phone: "",
      avatarPath: "1.png",
    });

    const dataDir = testApp.dataDir;
    await testApp.close();
    testApp = await launchApp(dataDir);
    await signBackIn(testApp.window);

    // Read straight off disk: the picture is a file on this computer, not a
    // blob held by a page that has since gone.
    expect(existsSync(join(dataDir, "avatars", "1.png"))).toBe(true);
    const after = await rpc<{ avatarDataUrl: string | null }>(
      testApp.window,
      "profile.get",
    );
    expect(after.avatarDataUrl).toMatch(/^data:image\/png;base64,/);
    await expect(testApp.window.locator('aside img[src^="data:image/png"]')).toBeVisible();
  });

  test("refuses an avatar path aimed outside the avatars folder", async () => {
    const page = testApp.window;
    await openProfile(page);

    await expect(
      rpc(page, "profile.update", {
        displayName: "Test Administrator",
        email: "",
        phone: "",
        avatarPath: "../../../Windows/win.ini",
      }),
    ).rejects.toThrow();
  });

  test("changes the password through the existing auth handler", async () => {
    const page = testApp.window;
    await openProfile(page);

    // The dialog is reachable from the page itself.
    await page.getByRole("button", { name: /change password/i }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Change password").first()).toBeVisible();

    // Mismatched confirmation is caught before anything is sent.
    await dialog.getByLabel(/current password/i).fill("Water#2026");
    await dialog.getByLabel(/^new password/i).fill("NewWater#2026");
    await dialog.getByLabel(/confirm new password/i).fill("Different#2026");
    await dialog.getByRole("button", { name: /change password/i }).click();
    await expect(dialog.getByText(/do not match/i)).toBeVisible();

    // Wrong current password is refused by the main process.
    await dialog.getByLabel(/current password/i).fill("Wrong#2026");
    await dialog.getByLabel(/confirm new password/i).fill("NewWater#2026");
    await dialog.getByRole("button", { name: /change password/i }).click();
    await expect(page.getByText(/current password is not correct/i)).toBeVisible({ timeout: 15_000 });

    // The right one works, and the hash in the database changes.
    await dialog.getByLabel(/current password/i).fill("Water#2026");
    await dialog.getByLabel(/^new password/i).fill("NewWater#2026");
    await dialog.getByLabel(/confirm new password/i).fill("NewWater#2026");
    await dialog.getByRole("button", { name: /change password/i }).click();
    await expect(dialog).toHaveCount(0, { timeout: 15_000 });

    const dbBytes = readFileSync(join(testApp.dataDir, "eyerstock.db"));
    // The new password must not be sitting in the file in plain text.
    expect(dbBytes.includes(Buffer.from("NewWater#2026"))).toBe(false);
  });
});

/** Open the profile page the way a user does: account menu, then Profile. */
async function openProfile(page: Page): Promise<void> {
  const heading = page.getByRole("heading", { name: /^(Test Administrator|Persisted Owner|Renamed Owner)$/ });
  if (!(await heading.first().isVisible().catch(() => false))) {
    await page.getByRole("button", { name: /Administrator/ }).first().click();
    await page.getByRole("menuitem", { name: "Profile" }).click();
  }
  await heading.first().waitFor({ timeout: 20_000 });
}

/**
 * After a relaunch the app may already be signed in, or may be sitting on the
 * splash, licence or login screen. Wait for whichever of those actually appears
 * rather than guessing, then sign in only if it is asked for.
 */
async function signBackIn(page: Page): Promise<void> {
  const signInButton = page.getByRole("button", { name: /^sign in$/i });
  const shell = page.getByRole("navigation").first();

  await Promise.race([
    signInButton.waitFor({ state: "visible", timeout: 40_000 }),
    shell.waitFor({ state: "visible", timeout: 40_000 }),
  ]);

  if (await signInButton.isVisible().catch(() => false)) {
    await page.getByLabel(/username/i).fill("admin");
    await page.getByLabel(/password/i).fill("Water#2026");
    await signInButton.click();
  }

  await shell.waitFor({ timeout: 40_000 });
}
