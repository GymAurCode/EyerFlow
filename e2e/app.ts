import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";

/**
 * Test application under test.
 *
 * Each test gets its own data folder (database, settings, logs, backups) under
 * the OS temp directory, so a run can never touch a real shop's data and tests
 * never see each other's rows. `EYERSTOCK_DATA_DIR` is the documented override for
 * exactly this purpose.
 */

export const ADMIN_USERNAME = "admin";
export const ADMIN_PASSWORD = "Water#2026";
export const COMPANY_NAME = "Blue Water Trading";

/**
 * Today's date, as the application sees it.
 *
 * The application dates a record by the local day - the shop's own calendar -
 * so the tests have to use the same day. `toISOString()` would give the UTC
 * date, which is a different day for five hours every evening in Pakistan and
 * for a few hours in most other places: a sale recorded "today" would then
 * land yesterday, and the dashboard would show nothing for it.
 */
export function todayIso(now: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export interface TestApp {
  readonly app: ElectronApplication;
  readonly window: Page;
  readonly dataDir: string;
  close(): Promise<void>;
}

let dataDirCounter = 0;

/**
 * A temp data folder the caller owns.
 *
 * `launchApp` deletes the folder it created when it closes, which is right for
 * one-shot tests and wrong for a test that relaunches into the same folder: the
 * first close would take the database with it. A test that restarts the app
 * creates the folder itself, passes it to every launch, and removes it at the
 * end.
 */
export function createTestDataDir(): string {
  dataDirCounter += 1;
  return mkdtempSync(join(tmpdir(), `eyerstock-e2e-${String(dataDirCounter)}-`));
}

export function removeTestDataDir(dataDir: string): void {
  try {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* a leftover temp folder must not fail an otherwise passing test */
  }
}

export async function launchApp(existingDataDir?: string): Promise<TestApp> {
  dataDirCounter += 1;
  const ownsDataDir = existingDataDir === undefined;
  const dataDir =
    existingDataDir ?? mkdtempSync(join(tmpdir(), `eyerstock-e2e-${String(dataDirCounter)}-`));

  const app = await electron.launch({
    args: [process.cwd(), `--eyerstock-e2e=${dataDir}`],
    cwd: process.cwd(),
    env: {
      ...process.env,
      // Production mode: the renderer loads from dist/renderer via file://, so
      // no dev server is needed and the built bundle is what gets tested.
      NODE_ENV: "production",
      ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
      EYERSTOCK_DATA_DIR: dataDir,
      // No licence key exists for an automated run, and the activation screen
      // would otherwise block every test before it reached the UI under test.
      // The app only honours this outside a packaged build.
      LICENCE_DISABLED: "1",
    },
    timeout: 60_000,
  });

  const window = await app.firstWindow({ timeout: 60_000 });
  await window.waitForLoadState("domcontentloaded");

  // The renderer never crashes in these tests; fail loudly with the main-process
  // log if it does, because a silent white window would be a useless failure.
  window.on("pageerror", (error: Error) => {
    throw new Error(`Renderer crashed: ${error.message}`);
  });

  return {
    app,
    window,
    dataDir,
    async close() {
      // The folder is only removed when this launch created it. A test that
      // relaunches into the same folder owns it itself, and the first close must
      // leave it - and its database - alone.
      await app.close();
      if (!ownsDataDir) return;
      removeTestDataDir(dataDir);
    },
  };
}

/* -------------------------------------------------------------------------- */
/* screen helpers                                                             */
/* -------------------------------------------------------------------------- */

/** Fill a labelled form field. The label text is translated, so match loosely. */
export async function fillByLabel(page: Page, label: RegExp, value: string): Promise<void> {
  const field = page.getByLabel(label).first();
  await field.waitFor({ state: "visible", timeout: 20_000 });
  await field.fill(value);
}

/**
 * Deal with the first-login theme chooser if it is showing.
 *
 * A fresh data folder starts with onboarding incomplete, so the first sign-in
 * raises the chooser. "Keep current" records that it has been seen without
 * changing the palette, which keeps the rest of the suite on the default pack.
 * Tests that are about the chooser pass `skipThemeOnboarding: false` to
 * `completeSetup` and drive it themselves.
 */
export async function dismissThemeOnboarding(page: Page): Promise<void> {
  const keep = page.getByRole("button", { name: /^keep current$/i });
  const appeared = await keep
    .waitFor({ state: "visible", timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) return;

  await keep.click();
  await page
    .getByRole("dialog")
    .waitFor({ state: "hidden", timeout: 10_000 })
    .catch(() => undefined);
}

export interface CompleteSetupOptions {
  /**
   * Defaults to true. Pass false when the test itself is about the chooser and
   * needs to see it still open when setup returns.
   */
  readonly skipThemeOnboarding?: boolean;
}

/** Complete the first-run setup wizard with the standard test company. */
export async function completeSetup(page: Page, options: CompleteSetupOptions = {}): Promise<void> {
  await page.getByText("Create administrator account").waitFor({ timeout: 30_000 });

  await fillByLabel(page, /company name/i, COMPANY_NAME);
  // The field is labelled "Your name" on the wizard; "display name" was the old
  // label and silently timed out every test that used this helper.
  await fillByLabel(page, /your name/i, "Test Administrator");
  // Anchored at the start only: a required field renders its marker inside the
  // <label>, so the label text is "Username*" and "^username$" never matches.
  await fillByLabel(page, /^username/i, ADMIN_USERNAME);
  await fillByLabel(page, /^password/i, ADMIN_PASSWORD);

  await page.getByRole("button", { name: /finish setup/i }).click();

  // Setup creates the administrator but deliberately does not start a session,
  // so the app lands on the login screen. Sign in to reach the shell.
  await page.getByRole("button", { name: /^sign in$/i }).waitFor({ timeout: 30_000 });
  await fillByLabel(page, /username/i, ADMIN_USERNAME);
  await fillByLabel(page, /password/i, ADMIN_PASSWORD);
  await page.getByRole("button", { name: /^sign in$/i }).click();

  if (options.skipThemeOnboarding === false) {
    // The chooser is modal, so Radix hides the shell from the accessibility
    // tree. Wait for the chooser itself; the test will drive it.
    await page.getByRole("dialog").waitFor({ timeout: 30_000 });
    return;
  }

  // Dismiss before waiting for the shell: while the modal is up, the sidebar
  // is aria-hidden and `getByRole("navigation")` cannot see it.
  await dismissThemeOnboarding(page);
  await page.getByRole("navigation").first().waitFor({ timeout: 30_000 });
}

/** Wait for the shell and the dashboard to be ready. */
export async function waitForDashboard(page: Page): Promise<void> {
  await page.getByRole("navigation").first().waitFor({ timeout: 30_000 });
  // `.last()` because the top bar shows the route name as a heading too, and
  // the page's own heading is the one below it.
  await page.getByRole("heading", { name: "Dashboard" }).last().waitFor({ timeout: 30_000 });
}

/**
 * Open Settings and select a section.
 *
 * Backups live under Settings, not on a sidebar link of their own. The section
 * list is a vertical nav of buttons rather than a tab strip, so the click
 * targets the button inside the "Settings sections" landmark.
 */
export async function openSettingsTab(page: Page, tab: string): Promise<void> {
  await page
    .getByRole("link", { name: /^settings$/i })
    .first()
    .click();
  await page
    .getByRole("navigation", { name: /settings sections/i })
    .getByRole("button", { name: new RegExp(tab, "i") })
    .click();
}

export async function signIn(page: Page): Promise<void> {
  await page.getByRole("button", { name: /^sign in$/i }).waitFor({ timeout: 30_000 });
  await fillByLabel(page, /username/i, ADMIN_USERNAME);
  await fillByLabel(page, /password/i, ADMIN_PASSWORD);
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await dismissThemeOnboarding(page);
  await page.getByRole("navigation").first().waitFor({ timeout: 30_000 });
}

/** Open a page through the sidebar, which is how a user actually navigates. */
export async function navigateTo(page: Page, linkName: RegExp): Promise<void> {
  await page.getByRole("link", { name: linkName }).first().click();
  await page.waitForTimeout(400);
}

/** Call an RPC method from the renderer, the way a page would. */
export async function rpc<T>(
  page: Page,
  method: string,
  payload: Record<string, unknown> = {},
): Promise<T> {
  return page.evaluate(
    async ([rpcMethod, rpcPayload]) => {
      const api = (
        window as unknown as { api: { invoke: (m: string, p: unknown) => Promise<unknown> } }
      ).api;
      const result = (await api.invoke(rpcMethod, rpcPayload)) as {
        ok: boolean;
        data?: unknown;
        error?: { message: string };
      };
      if (!result.ok) {
        throw new Error(`RPC ${rpcMethod} failed: ${result.error?.message ?? "unknown error"}`);
      }
      return result.data;
    },
    [method, payload] as [string, Record<string, unknown>],
  ) as Promise<T>;
}

/** Read the main-process log; useful for diagnosing a failed assertion. */
export async function mainLog(testApp: TestApp): Promise<string> {
  const file = await testApp.app.evaluate(async ({ app: electronApp }) => {
    const path = electronApp.getPath("userData");
    const fs = await import("node:fs");
    const logDir = `${path}\\logs`;
    if (!fs.existsSync(logDir)) return "";
    const files = fs.readdirSync(logDir).sort();
    const latest = files[files.length - 1];
    return latest === undefined ? "" : fs.readFileSync(`${logDir}\\${latest}`, "utf8");
  });
  return file;
}
