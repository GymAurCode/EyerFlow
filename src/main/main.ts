/**
 * Main process entry point.
 *
 * Startup order matters and is deliberate:
 *   single-instance lock -> crash handlers -> context (encrypted db) ->
 *   settings -> migrations (with a safety backup) -> IPC -> window.
 *
 * Nothing reaches the renderer until migrations have completed, so no screen
 * can ever observe a half-migrated schema.
 */

import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { app, BrowserWindow, dialog, session as electronSession } from "electron";
import {
  type AppContext,
  createAppContext,
  explicitDataDirOverride,
  migrateLegacyDataDirectory,
} from "./app-context";
import type { Logger } from "./logger";
import { buildBackupFilename, createBackup, pruneBackups } from "../data/backup";
import { findModifiedMigrations, runMigrations } from "../data/migrator";
import { migrations } from "../data/migrations";
import { seedChartOfAccounts } from "./accounting/chart";
import { hashPassword } from "../domain/auth";
import type { MigrationStatus } from "../shared/ipc";
import { IPC } from "../shared/ipc";
import { createSessionToken, registerIpcHandlers } from "./ipc";
import { warmMachineId } from "./machine-id";
import { SessionStore } from "./session";
import { SettingsService } from "./settings";
import { createUpdateService } from "./updater";
import type { UpdateService } from "./updater";
import { createMainWindow, applyContentSecurityPolicy } from "./window";

const isDev = process.env["NODE_ENV"] === "development";

/**
 * In development, redirect userData to a separate folder so the dev database
 * never mixes with the installed app's data. The folder is stable across
 * restarts, so the dev session persists.
 */
if (!app.isPackaged && isDev) {
  const devUserData = `${app.getPath("userData")}-dev`;
  app.setPath("userData", devUserData);
}

const DEV_SESSION_FILE = "dev-session.json";

function getDevSessionPath(): string {
  return join(app.getPath("userData"), DEV_SESSION_FILE);
}

function saveDevSession(userId: number, roleId: number | null): void {
  if (app.isPackaged) return;
  try {
    writeFileSync(getDevSessionPath(), JSON.stringify({ userId, roleId }), "utf8");
  } catch {
    // Best-effort; session persistence is not critical
  }
}

function loadDevSession(): { userId: number; roleId: number | null } | null {
  if (app.isPackaged) return null;
  try {
    const path = getDevSessionPath();
    if (!existsSync(path)) return null;
    const data = JSON.parse(readFileSync(path, "utf8")) as { userId: number; roleId: number | null };
    return data;
  } catch {
    return null;
  }
}

function clearDevSession(): void {
  if (app.isPackaged) return;
  try {
    rmSync(getDevSessionPath(), { force: true });
  } catch {
    // Best-effort
  }
}

/**
 * Redirect Chromium's own user-data directory before anything else.
 *
 * Electron keys several things on `userData`: the single-instance lock below
 * all, plus GPU and network caches. Without this, an isolated run - an end-to-end
 * test using a temporary `EYERSTOCK_DATA_DIR`, or a developer's second checkout -
 * would still contend with the real installation for the lock and silently
 * refuse to start, because the lock lives in `%APPDATA%\EyerStock` even
 * when the database itself has been redirected.
 *
 * Doing it here, before `requestSingleInstanceLock`, makes the override total:
 * a redirected instance touches nothing belonging to a real one. Only the
 * override case touches the app at all, so nothing here depends on the app
 * having finished starting.
 */
const dataDirOverride = explicitDataDirOverride();
if (dataDirOverride !== null) {
  app.setPath("userData", dataDirOverride);
}

/**
 * Only one instance may own the SQLite file. A second instance opening the same
 * database is the classic way WAL and schema migrations get corrupted, so this
 * lock is mandatory rather than a nicety.
 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let context: AppContext | null = null;
let settings: SettingsService | null = null;
let updater: UpdateService | null = null;

let migrationStatus: MigrationStatus = {
  fromVersion: 0,
  toVersion: 0,
  applied: [],
  safetyBackupPath: null,
};

function currentContext(): AppContext {
  if (context === null) {
    throw new Error("Application context is not initialised yet.");
  }
  return context;
}

function currentSettings(): SettingsService {
  if (settings === null) {
    throw new Error("Settings are not loaded yet.");
  }
  return settings;
}

function installCrashHandlers(activeContext: AppContext): void {
  const { log } = activeContext;

  process.on("uncaughtException", (error: Error) => {
    log.error("Uncaught exception in main process", {
      errorName: error.name,
      ...(isDev ? { message: error.message, stack: error.stack ?? "" } : {}),
    });
  });

  process.on("unhandledRejection", (reason: unknown) => {
    log.error("Unhandled promise rejection in main process", {
      errorName: reason instanceof Error ? reason.name : "UnknownError",
      ...(isDev ? { reason: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? reason.stack : undefined } : {}),
    });
  });
}

/**
 * Run migrations, taking a verified safety backup first.
 *
 * The backup runs on every launch that has pending migrations. It is skipped
 * when nothing is pending, so a normal day-to-day start costs nothing.
 */
async function migrateWithSafetyBackup(activeContext: AppContext): Promise<void> {
  const { log, db, paths } = activeContext;

  // A migration that has already run on this shop's database must never be
  // edited: fresh installs would get the new behaviour while this till kept the
  // old one, and the two would diverge silently. Refuse to start instead.
  const modified = findModifiedMigrations(db, migrations);
  if (modified.length > 0) {
    const names = modified.map((entry) => `${String(entry.version)} ("${entry.name}")`).join(", ");
    log.error("Already-applied migrations have been modified", { modified: names });
    throw new Error(
      `This database was created by a different build: migration(s) ${names} have already been ` +
        `applied and have since been edited. Restore a backup made before that change, or ` +
        `reinstall the exact version this database was created with.`,
    );
  }

  const result = runMigrations(db, migrations, () => {
    log.info("Pending migrations detected, taking a pre-migration safety backup");
  });

  migrationStatus = {
    fromVersion: result.fromVersion,
    toVersion: result.toVersion,
    applied: result.applied.map((entry) => ({ version: entry.version, name: entry.name })),
    safetyBackupPath: null,
  };

  // The runner's hook is synchronous, but the backup is not, so the actual
  // snapshot is taken here once we know migrations are pending.
  if (result.applied.length > 0) {
    try {
      const safetyPath = join(
        paths.defaultBackupDir,
        `pre-migration-v${String(result.fromVersion)}-${buildBackupFilename("backup", new Date())}`,
      );
      const backup = await createBackup(db, safetyPath, activeContext.databaseKey);
      migrationStatus = { ...migrationStatus, safetyBackupPath: backup.path };
      log.info("Pre-migration safety backup written", { path: backup.path });
    } catch (error) {
      // A failed safety backup must not silently continue into a migration.
      log.error("Safety backup failed; aborting startup before migrating", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}

function backupDirectory(): string {
  const configured = currentSettings().file().backupDirectory;
  return configured.length > 0 ? configured : currentContext().paths.defaultBackupDir;
}

/**
 * Daily automatic backup.
 *
 * Runs on the first launch of the day. An offline single-machine app cannot
 * schedule itself to start at 2am, so "daily" means "first open of the day";
 * the on-close backup then captures the rest of that day's work.
 */
function scheduleDailyBackupCheck(): void {
  const file = currentSettings().file();
  if (!file.dailyBackupEnabled) return;

  const today = new Date().toISOString().slice(0, 10);
  if (file.lastBackupAtIso?.slice(0, 10) === today) return;

  void (async () => {
    const activeContext = currentContext();
    try {
      const path = join(backupDirectory(), buildBackupFilename("auto", new Date()));
      const result = await createBackup(activeContext.db, path, activeContext.databaseKey);
      pruneBackups(backupDirectory(), file.backupKeepCount);
      currentSettings().noteBackup(result.createdAtIso);
      activeContext.log.info("Daily automatic backup completed", { path });
    } catch (error) {
      activeContext.log.error("Daily automatic backup failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();
}

/**
 * How long after launch the application looks for an update.
 *
 * Long enough that opening the shop's books is never waiting on the network,
 * short enough that the shopkeeper is told before they have finished their
 * first task.
 */
const UPDATE_CHECK_DELAY_MS = 15_000;

/**
 * Look for an update shortly after the app starts.
 *
 * The check is one request to the release server and changes nothing on this
 * computer, so it may happen on its own. Nothing is downloaded and nothing is
 * installed until the user asks for it: the download is the thing that takes
 * bandwidth and disk, and the install is the thing that closes the app.
 *
 * A build that cannot update itself - a development build, which has no
 * release manifest - is skipped entirely.
 */
function scheduleUpdateCheck(service: UpdateService, log: Logger): void {
  if (!service.status().supported) return;

  const timer = setTimeout(() => {
    void service.check().catch((error: unknown) => {
      log.error("The scheduled update check failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, UPDATE_CHECK_DELAY_MS);

  // The timer must not be a reason for the app to stay alive.
  timer.unref();
}

function openWindow(): BrowserWindow {
  const activeContext = currentContext();
  const window = createMainWindow({
    rendererUrl: process.env["VITE_DEV_SERVER_URL"] ?? "http://localhost:5273",
    preloadPath: join(__dirname, "..", "preload", "preload.js"),
    isDev,
    log: activeContext.log,
    token: currentSessionToken,
  });
  window.on("closed", () => {
    window.destroy();
  });
  return window;
}

/**
 * Per-session token.
 *
 * Generated once at startup and handed to both the RPC dispatcher and the
 * preload bridge, so only this window's renderer can call the API.
 */
let currentSessionToken = "";

/**
 * Logger for the brief window before the app context exists.
 *
 * Writes to stderr only, and deliberately does not create the data folder: the
 * rename migration decides whether to move the old folder by checking that the
 * new one does not already exist, so logging "properly" this early would make
 * the destination exist and silently skip the migration.
 */
const bootstrapLog: Logger = {
  debug: (message) => {
    process.stderr.write(`[debug] ${message}\n`);
  },
  info: (message) => {
    process.stderr.write(`[info] ${message}\n`);
  },
  warn: (message) => {
    process.stderr.write(`[warn] ${message}\n`);
  },
  error: (message) => {
    process.stderr.write(`[error] ${message}\n`);
  },
};

async function main(): Promise<void> {
  // The database, logs, backups and settings all live beside the Chromium
  // user-data directory that was redirected above, so an isolated run touches
  // nothing belonging to a real installation.
  //
  // Renaming the product moves that directory, so an installation made under
  // the previous name is moved across first. Done before the context is built,
  // because by then the old database would be a different file entirely.
  if (dataDirOverride === null) {
    migrateLegacyDataDirectory(app.getPath("userData"), app.getPath("appData"), bootstrapLog);
  }

  context = createAppContext();
  const activeContext = currentContext();

  installCrashHandlers(activeContext);

  // Migrations run before anything reads or writes a table. On a brand-new
  // install the schema does not exist yet, so a settings read placed earlier
  // would fail with "no such table: settings" before the wizard could ever show.
  await migrateWithSafetyBackup(activeContext);

  settings = new SettingsService(
    activeContext.db,
    activeContext.paths.settingsFile,
    activeContext.log,
  );

  // The Chart of Accounts. Seeded on every start, which is safe because the
  // seeder only ever inserts a code that is missing - a shop that has renamed
  // an account keeps the name it chose.
  try {
    const added = seedChartOfAccounts(activeContext.db, new Date().toISOString());
    if (added > 0) {
      activeContext.log.info("Chart of accounts seeded", { added });
    }
  } catch (error) {
    activeContext.log.error("Could not seed the chart of accounts", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Persist immediately so a normalised settings file exists on first run and
  // is visible to the shopkeeper.
  currentSettings().update({});

  // In development, ensure a dev user exists with full access for testing.
  // Credentials: username `dev`, password `DevPass1`, role Administrator
  // (all modules including Manufacturing). Only created when no `dev` user
  // already exists; never runs in packaged builds.
  if (isDev && !app.isPackaged) {
    try {
      const adminRoleRow = activeContext.db
        .prepare("SELECT id FROM roles WHERE name = 'Administrator'")
        .get() as { id: number } | undefined;
      if (adminRoleRow !== undefined) {
        const existing = activeContext.db
          .prepare("SELECT id FROM users WHERE username = 'dev'")
          .get() as { id: number } | undefined;
        if (existing === undefined) {
          const stored = hashPassword("DevPass1");
          activeContext.db
            .prepare(
              `INSERT INTO users
                 (username, display_name, password_hash, password_salt, role_id,
                  must_change_password, is_active, failed_attempts, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, 0, 1, 0, ?, ?)`,
            )
            .run(
              "dev",
              "Development User",
              stored.hash,
              stored.salt,
              adminRoleRow.id,
              new Date().toISOString(),
              new Date().toISOString(),
            );
          activeContext.log.info("Dev user created", {
            username: "dev",
            role: "Administrator",
          });
        }
      }
    } catch (error) {
      activeContext.log.error("Could not create dev user", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Ensure the Administrator role holds manufacturing permissions so the dev
  // account (and any Administrator) can access every MMS screen. This runs on
  // every start in development, so even databases that predate migration 26 get
  // the permission without requiring a migration re-run.
  if (isDev && !app.isPackaged) {
    try {
      const adminRole = activeContext.db
        .prepare("SELECT id FROM roles WHERE name = 'Administrator'")
        .get() as { id: number } | undefined;
      if (adminRole !== undefined) {
        const insertPerm = activeContext.db.prepare(
          "INSERT OR IGNORE INTO role_permissions (role_id, module, action) VALUES (?, ?, ?)",
        );
        for (const action of [
          "view",
          "create",
          "edit",
          "delete",
          "cancel",
          "export",
        ]) {
          insertPerm.run(adminRole.id, "manufacturing", action);
        }
        activeContext.log.info("Manufacturing permissions ensured for Administrator role");
      }
    } catch (error) {
      activeContext.log.error("Could not ensure manufacturing permissions", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  currentSessionToken = createSessionToken();

  // The policy has to be on the session before any document loads, so it is
  // installed here rather than inside window construction.
  applyContentSecurityPolicy(electronSession.defaultSession, isDev);

  // Start reading the hardware identifiers now. It shells out to the OS, so
  // doing it here means the license check the renderer makes on first paint
  // finds a warm cache instead of waiting on three helper processes.
  warmMachineId();

  const session = new SessionStore(activeContext.db, activeContext.paths.avatarsDir);

  const updaterService = createUpdateService({ log: activeContext.log });
  updater = updaterService;

  // Every change in the updater's state is pushed to the windows, so a
  // download that runs in the background reports its progress on the screen
  // that is waiting for it.
  updaterService.onChange((status) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed()) continue;
      window.webContents.send(IPC.updateStatus, status);
    }
  });

  registerIpcHandlers({
    context: activeContext,
    settings: currentSettings(),
    session,
    updater: updaterService,
    getMigrationStatus: () => migrationStatus,
    token: currentSessionToken,
    saveDevSession,
    loadDevSession,
    canRestoreDevSession: () => !app.isPackaged && process.env["DEV_AUTOLOGIN"] !== "0",
    clearDevSession,
  });

  openWindow();
  scheduleDailyBackupCheck();
  scheduleUpdateCheck(updaterService, activeContext.log);

  activeContext.log.info("Application started", {
    version: app.getVersion(),
    schemaVersion: migrationStatus.toVersion,
    encryption: activeContext.encryption.mode,
    packaged: app.isPackaged,
  });
}

// Second launch: focus the existing window rather than starting a rival
// instance that would fight over the database file.
app.on("second-instance", () => {
  const [existing] = BrowserWindow.getAllWindows();
  if (existing !== undefined) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
  }
});

// Back up on close, so work since the last daily backup is never lost.
app.on("before-quit", () => {
  if (context === null || settings === null) return;

  const activeContext = context;
  const activeSettings = settings;

  void (async () => {
    try {
      const file = activeSettings.file();
      if (!file.dailyBackupEnabled) return;

      const directory =
        file.backupDirectory.length > 0
          ? file.backupDirectory
          : activeContext.paths.defaultBackupDir;

      const onClose = join(directory, buildBackupFilename("onclose", new Date()));
      await createBackup(activeContext.db, onClose, activeContext.databaseKey);
      activeSettings.noteBackup(new Date().toISOString());
      activeContext.log.info("Backup on close completed", { path: onClose });
    } catch (error) {
      activeContext.log.error("Backup on close failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("activate", () => {
  // macOS: clicking the dock icon with no windows open reopens the app.
  if (BrowserWindow.getAllWindows().length === 0 && context !== null) {
    openWindow();
  }
});

process.on("exit", () => {
  updater?.dispose();
  context?.dispose();
});

/**
 * Startup must not begin until Electron is ready.
 *
 * `main()` creates a `BrowserWindow`, which is illegal before the `ready` event.
 * Calling it straight from module scope happened to work on a fresh install only
 * because the pre-migration backup is awaited, and that await gave the event
 * loop long enough for Electron to finish starting. On a database that was
 * already migrated there is nothing to await, the promise resumes in a
 * microtask - still before `ready` - and the app died with "Cannot create
 * BrowserWindow before app is ready". The gate is what makes startup correct on
 * every path rather than accidentally correct on some of them.
 */
void app
  .whenReady()
  .then(main)
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);

    // Log through the context if it exists, otherwise there is nothing to log to.
    if (context !== null) {
      context.log.error("Fatal startup error", { error: message });
    } else {
      process.stderr.write(`Fatal startup error: ${message}\n`);
    }

    dialog.showErrorBox(
      "EyerStock could not start",
      `${message}\n\nYour data has not been changed. A log and a backup of your database ` +
        `are in the app's data folder.\n\nContact your supplier and ask them to run ` +
        `"Export diagnostics" from the app.`,
    );

    app.exit(1);
  });
