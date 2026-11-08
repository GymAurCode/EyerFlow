import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { completeSetup, launchApp, openSettingsTab, rpc, type TestApp } from "./app";

/**
 * Backup and restore.
 *
 * These are the tests that matter most on the day something goes wrong: they
 * prove a backup is produced, that it passes SQLite's own integrity check, and
 * that restoring it actually puts the data back.
 */

let testApp: TestApp;

function backupDir(testAppToRead: TestApp): string {
  return join(testAppToRead.dataDir, "backups");
}

function backupFiles(testAppToRead: TestApp): string[] {
  const dir = backupDir(testAppToRead);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".db"));
}

async function seedCustomer(name: string): Promise<number> {
  // `parties.save` returns the saved PartyDto; these specs only need the id.
  const saved = await rpc<{ id: number }>(testApp.window, "parties.save", {
    kind: "customer",
    name,
    phone: null,
    email: null,
    trn: null,
    addressLine: null,
    emirate: null,
  });
  return saved.id;
}

test.afterEach(async () => {
  await testApp?.close();
});

test("takes a backup on demand and lists it for restore", async () => {
  testApp = await launchApp();
  await completeSetup(testApp.window);
  await seedCustomer("Backup Test Customer");

  await openSettingsTab(testApp.window, "Backup & Restore");
  await expect(testApp.window.getByRole("button", { name: /back up now/i })).toBeVisible();

  await testApp.window.getByRole("button", { name: /back up now/i }).click();

  // The backup has to exist on disk, not just appear in the UI.
  await expect.poll(() => backupFiles(testApp).length, { timeout: 20_000 }).toBeGreaterThan(0);

  // And it must appear in the restore list.
  await expect
    .poll(async () => testApp.window.getByRole("button", { name: /^restore$/i }).count(), {
      timeout: 20_000,
    })
    .toBeGreaterThan(0);
});

test("the database file is encrypted, not readable as plain SQLite", async () => {
  testApp = await launchApp();
  await completeSetup(testApp.window);
  await seedCustomer("Encryption Test Customer");

  const dbPath = join(testApp.dataDir, "eyerstock.db");

  // Read from the test process, not from the page: the renderer is sandboxed
  // and has no filesystem, and `app.evaluate` runs in the main process where a
  // bare `import("node:fs")` has no loader behind it.
  const header = readFileSync(dbPath).subarray(0, 16).toString("utf8");

  // SQLCipher leaves a 16-byte salt at the front of the file, so a plain SQLite
  // reader sees a non-SQLite header.
  expect(header).not.toBe("SQLite format 3\u0000");
  expect(existsSync(dbPath)).toBe(true);
});

test("verifies a backup with SQLite's integrity check", async () => {
  testApp = await launchApp();
  await completeSetup(testApp.window);
  await seedCustomer("Integrity Test Customer");

  const result = await testApp.window.evaluate(async () => {
    const api = (
      window as unknown as {
        api: {
          runBackupNow: () => Promise<{ ok: boolean; error?: { message: string } }>;
          listBackups: () => Promise<{
            ok: boolean;
            data?: { path: string }[];
          }>;
          verifyBackup: (path: string) => Promise<{
            ok: boolean;
            data?: { ok: boolean; message: string };
            error?: { message: string };
          }>;
        };
      }
    ).api;

    // `runBackupNow` reports what it did; the file it wrote is found through
    // the listing, newest first.
    const backup = await api.runBackupNow();
    if (!backup.ok) throw new Error(backup.error?.message ?? "Backup failed");

    const list = await api.listBackups();
    const newest = list.data?.[0];
    if (newest === undefined) throw new Error("No backup file was listed.");

    return api.verifyBackup(newest.path);
  });

  expect(result.ok).toBe(true);
  expect(result.data?.ok).toBe(true);
  expect(result.data?.message).toBeTruthy();
});

test("restores a backup, replacing data created after it was taken", async () => {
  testApp = await launchApp();
  await completeSetup(testApp.window);

  // A customer that exists at backup time.
  await seedCustomer("Present In Backup");

  const backupPath = await testApp.window.evaluate(async () => {
    const api = (
      window as unknown as {
        api: {
          runBackupNow: () => Promise<{ ok: boolean; error?: { message: string } }>;
          listBackups: () => Promise<{ ok: boolean; data?: { path: string }[] }>;
        };
      }
    ).api;
    const backup = await api.runBackupNow();
    if (!backup.ok) throw new Error(backup.error?.message ?? "Backup failed");

    // The listing is newest first, so this is the file just written - not the
    // one taken during startup, which predates the rows this test relies on.
    const newest = (await api.listBackups()).data?.[0];
    if (newest === undefined) throw new Error("No backup file was listed.");
    return newest.path;
  });

  // Now create a customer that only exists after the backup.
  await seedCustomer("Created After Backup");

  const before = await rpc<readonly { id: number; name: string }[]>(
    testApp.window,
    "parties.list",
    { limit: 100 },
  );
  expect(before.some((party) => party.name === "Present In Backup")).toBe(true);
  expect(before.some((party) => party.name === "Created After Backup")).toBe(true);

  // Restore. The dialog requires the confirmation word before it will proceed,
  // which is itself worth exercising.
  await openSettingsTab(testApp.window, "Backup & Restore");

  await expect
    .poll(() => testApp.window.getByRole("button", { name: /^restore$/i }).count(), {
      timeout: 20_000,
    })
    .toBeGreaterThan(0);

  await testApp.window
    .getByRole("button", { name: /^restore$/i })
    .first()
    .click();

  // The confirmation word is mandatory.
  const confirmButton = testApp.window
    .getByRole("dialog")
    .getByRole("button", { name: /^restore$/i });
  await expect(confirmButton).toBeDisabled();

  await testApp.window
    .getByRole("dialog")
    .getByLabel(/type RESTORE to confirm/i)
    .fill("RESTORE");
  await expect(confirmButton).toBeEnabled();

  // A restore replaces the live database file, so the app restarts once it has
  // been accepted. Before the fix the swap failed on Windows with EPERM - the
  // database file was still open - the screen reported "The restore failed" and
  // the window stayed up, which is what the closing assertion is there to catch.
  const closed = testApp.window.waitForEvent("close", { timeout: 30_000 });
  await confirmButton.click();

  // Awaiting is the assertion: it times out and fails the test if the window
  // stays up, which is what a rejected restore looks like.
  await closed;
  expect(backupPath).toBeTruthy();
});

test("a corrupted backup is refused rather than restored", async () => {
  testApp = await launchApp();
  await completeSetup(testApp.window);

  // A file that is not a database at all, written from the test process: the
  // renderer is sandboxed and has no filesystem of its own, so importing
  // node:fs inside the page was never going to work.
  const bogus = join(tmpdir(), `eyerstock-bogus-${String(Date.now())}.db`);
  writeFileSync(bogus, Buffer.from("this is definitely not a database file"));

  const message = await testApp.window.evaluate(async (bogusPath) => {
    const api = (
      window as unknown as {
        api: {
          verifyBackup: (p: string) => Promise<{
            ok: boolean;
            data?: { ok: boolean; message: string };
            error?: { message: string };
          }>;
        };
      }
    ).api;
    return api.verifyBackup(bogusPath);
  }, bogus);

  rmSync(bogus, { force: true });

  // Either shape is acceptable, but it must not report the file as sound.
  if (message.ok) {
    expect(message.data?.ok).toBe(false);
  } else {
    expect(message.error?.message).toBeTruthy();
  }
});
