/**
 * IPC handlers.
 *
 * Three rules enforced throughout:
 *  1. every payload is validated before use (Zod, in `rpc.ts` and here),
 *  2. every handler returns ApiResult rather than throwing across the bridge,
 *     so the renderer always receives a typed outcome, and
 *  3. the renderer must present a per-session token, which closes the door on a
 *     page that somehow got a live `ipcRenderer` handle.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { app, dialog, ipcMain, BrowserWindow } from "electron";
import { ZodError } from "zod";
import type {
  ApiResult,
  AppInfo,
  BackupFileInfo,
  BackupSummary,
  FilePickPurpose,
  MigrationStatus,
  RestoreVerificationInfo,
  UpdateStatus,
} from "../shared/ipc";
import { IPC } from "../shared/ipc";
import {
  backupRestoreSchema,
  backupVerifySchema,
  openExternalSchema,
  printHtmlSchema,
  savePdfSchema,
} from "../shared/validation";
import {
  buildBackupFilename,
  createBackup,
  pruneBackups,
  restoreBackup,
  verifyBackupFile,
} from "../data/backup";
import { getCurrentSchemaVersion } from "../data/migrator";
import type { AppContext } from "./app-context";
import { openExternalSafely, printHtml, saveHtmlAsPdf } from "./printing";
import { dispatchRpc, type RpcDeps } from "./rpc";
import type { SettingsService } from "./settings";
import type { UpdateService } from "./updater";

/** Word a shopkeeper must type to confirm a destructive restore. */
const RESTORE_CONFIRMATION_WORD = "RESTORE";

/**
 * File filters per picker purpose.
 *
 * The renderer sends a purpose, never a path, so it cannot use the picker to
 * enumerate the disk. Each purpose has its own filter set, which also means the
 * user is only ever shown file types the app can actually open.
 */
const PICK_FILTERS: Record<FilePickPurpose, Electron.FileFilter[]> = {
  restoreBackup: [{ name: "Backups", extensions: ["db"] }],
  exportDestination: [{ name: "CSV", extensions: ["csv"] }],
  companyLogo: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }],
};

function isFilePickPurpose(value: unknown): value is FilePickPurpose {
  return typeof value === "string" && Object.hasOwn(PICK_FILTERS, value);
}

function fail<T>(code: string, message: string, field?: string): ApiResult<T> {
  return { ok: false, error: field === undefined ? { code, message } : { code, message, field } };
}

function validationMessage(error: unknown): string {
  if (error instanceof ZodError) {
    return error.issues[0]?.message ?? "That value is not valid.";
  }
  return error instanceof Error ? error.message : String(error);
}

export interface IpcDeps {
  readonly context: AppContext;
  readonly settings: SettingsService;
  readonly session: RpcDeps["session"];
  /** The updater, which owns the application's own update state. */
  readonly updater: UpdateService;
  getMigrationStatus(): MigrationStatus;
  /** Per-session token handed to the renderer at startup. */
  readonly token: string;
  /** Dev-only: save session to file. */
  saveDevSession(userId: number, roleId: number | null): void;
  /** Dev-only: load session from file. */
  loadDevSession(): { userId: number; roleId: number | null } | null;
  /** Dev-only: check if session restoration is allowed. */
  canRestoreDevSession(): boolean;
  /** Dev-only: delete the saved session file. */
  clearDevSession(): void;
}

export function createSessionToken(): string {
  return randomBytes(24).toString("hex");
}

function backupDirectoryFor(deps: IpcDeps): string {
  const configured = deps.settings.file().backupDirectory;
  return configured.length > 0 ? configured : deps.context.paths.defaultBackupDir;
}

function summariseBackups(deps: IpcDeps): BackupSummary {
  const directory = backupDirectoryFor(deps);
  const file = deps.settings.file();

  let fileCount = 0;
  try {
    fileCount = readdirSync(directory).filter((name) => name.toLowerCase().endsWith(".db")).length;
  } catch {
    // A missing folder simply means no backups exist yet.
    fileCount = 0;
  }

  return {
    lastRunAtIso: file.lastBackupAtIso,
    destination: directory,
    keepCount: file.backupKeepCount,
    fileCount,
  };
}

function readLogTail(logsDir: string, maxLines = 200): string {
  try {
    const path = join(logsDir, "main.log");
    if (!existsSync(path)) return "(no log file)";
    return readFileSync(path, "utf8").split("\n").slice(-maxLines).join("\n");
  } catch {
    return "(could not read log)";
  }
}

export function registerIpcHandlers(deps: IpcDeps): void {
  const { context } = deps;
  const log = context.log;

  type Handler<T> = (payload: unknown) => ApiResult<T> | Promise<ApiResult<T>>;

  /**
   * Register a handler that always resolves to an ApiResult.
   *
   * Sync and async handlers are both accepted; the result is wrapped in
   * `Promise.resolve` so the renderer sees one consistent contract and a throw
   * becomes a typed failure instead of an unhandled rejection in main.
   */
  const handle = <T>(channel: string, handler: Handler<T>): void => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, (_event, payload: unknown) => {
      const failSafely = (error: unknown): ApiResult<T> => {
        const requestId = randomUUID();
        log.error(`IPC handler failed for ${channel}`, {
          requestId,
          operation: channel,
          errorName: error instanceof Error ? error.name : "UnknownError",
          ...(process.env["NODE_ENV"] === "development" ? {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          } : {}),
        });
        return { ok: false, error: { code: "UNEXPECTED", requestId,
          message: "The operation could not be completed. Please retry or contact support." } };
      };

      try {
        return Promise.resolve(handler(payload)).catch(failSafely);
      } catch (error) {
        return Promise.resolve(failSafely(error));
      }
    });
  };

  handle<AppInfo>(IPC.appInfo, () => ({
    ok: true,
    data: {
      name: app.getName(),
      version: app.getVersion(),
      electronVersion: process.versions.electron ?? "unknown",
      chromeVersion: process.versions.chrome ?? "unknown",
      nodeVersion: process.versions.node,
      platform: process.platform,
      schemaVersion: getCurrentSchemaVersion(context.db),
      locale: app.getLocale(),
      isPackaged: app.isPackaged,
    },
  }));

  handle<MigrationStatus>(IPC.dbMigrateStatus, () => ({
    ok: true,
    data: deps.getMigrationStatus(),
  }));

  /**
   * Shared picker implementation for both channels.
   *
   * Requires a signed-in session: an unauthenticated renderer must not be able
   * to make the main process show a dialog.
   */
  const pick = async (payload: unknown, title: string): Promise<ApiResult<string | null>> => {
    if (!isFilePickPurpose(payload)) {
      return fail("VALIDATION", "That file picker request was not recognised.");
    }
    try {
      deps.session.require("settings", "edit");
    } catch {
      return fail("FORBIDDEN", "You do not have permission to choose files.");
    }

    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    if (window === undefined) {
      return fail("NO_WINDOW", "No window is available to show the file picker.");
    }

    const result = await dialog.showOpenDialog(window, {
      title,
      properties: ["openFile"],
      filters: PICK_FILTERS[payload],
    });

    const chosen = result.canceled ? undefined : result.filePaths[0];
    return { ok: true, data: chosen ?? null };
  };

  handle<string | null>(IPC.pickFile, (payload) => pick(payload, "Choose a file"));
  handle<string | null>(IPC.pickImage, (payload) => pick(payload, "Choose an image"));

  handle<BackupSummary>(IPC.backupRunNow, async () => {
    try {
      const file = deps.settings.file();
      const directory = backupDirectoryFor(deps);
      const filename = buildBackupFilename("eyerstock", new Date());
      const result = await createBackup(context.db, join(directory, filename), context.databaseKey);

      pruneBackups(directory, file.backupKeepCount);
      deps.settings.noteBackup(result.createdAtIso);

      log.info("Manual backup completed", { path: result.path, sizeBytes: result.sizeBytes });
      return { ok: true, data: summariseBackups(deps) };
    } catch (error) {
      log.error("Backup failed", { error: error instanceof Error ? error.message : String(error) });
      return fail(
        "BACKUP_FAILED",
        "Backup failed. Check the backup folder is writable and has free space.",
      );
    }
  });

  handle<BackupSummary>(IPC.backupChooseFolder, async () => {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    if (window === undefined) {
      return fail("NO_WINDOW", "No window is available to show the folder picker.");
    }

    const result = await dialog.showOpenDialog(window, {
      title: "Choose backup folder",
      properties: ["openDirectory", "createDirectory"],
      defaultPath: backupDirectoryFor(deps),
    });

    if (!result.canceled && result.filePaths[0] !== undefined) {
      const chosen = result.filePaths[0];
      deps.settings.update({ backupDirectory: chosen });
      log.info("Backup folder changed", { backupDirectory: chosen });
    }

    return { ok: true, data: summariseBackups(deps) };
  });

  handle<readonly BackupFileInfo[]>(IPC.backupList, () => {
    const directory = backupDirectoryFor(deps);

    let files: BackupFileInfo[];
    try {
      files = readdirSync(directory)
        .filter((name) => name.toLowerCase().endsWith(".db"))
        .map((name) => {
          const fullPath = join(directory, name);
          const stats = statSync(fullPath);
          return {
            path: fullPath,
            name,
            sizeBytes: stats.size,
            modifiedAtIso: stats.mtime.toISOString(),
          };
        })
        .sort((a, b) => b.modifiedAtIso.localeCompare(a.modifiedAtIso));
    } catch {
      files = [];
    }

    return { ok: true, data: files };
  });

  handle<RestoreVerificationInfo>(IPC.backupVerify, (payload) => {
    const parsed = backupVerifySchema.safeParse(payload);
    if (!parsed.success) {
      return fail("INVALID_PATH", "No backup file was selected.", "path");
    }
    return { ok: true, data: verifyBackupFile(parsed.data, context.databaseKey) };
  });

  handle<MigrationStatus>(IPC.backupRestore, (payload) => {
    const parsed = backupRestoreSchema.safeParse(payload);
    if (!parsed.success) {
      return fail("INVALID_PATH", "No backup file was selected.", "path");
    }

    const request = parsed.data;

    // Typed confirmation: a restore replaces live data, so it must be a
    // deliberate act rather than a mis-click on the wrong row.
    if (request.confirmation !== RESTORE_CONFIRMATION_WORD) {
      return fail(
        "NOT_CONFIRMED",
        `Type ${RESTORE_CONFIRMATION_WORD} to confirm the restore.`,
        "confirmation",
      );
    }

    // Restoring is an administrator action; a cashier must not be able to
    // replace the whole database from the payments screen.
    try {
      deps.session.require("backup", "edit");
    } catch {
      return fail("FORBIDDEN", "Only an administrator can restore a backup.");
    }

    const verification = verifyBackupFile(request.path, context.databaseKey);
    if (!verification.ok) {
      return fail("INVALID_BACKUP", verification.message, "path");
    }

    // Read before closing: the schema version comes from the live database.
    const expectedSchemaVersion = getCurrentSchemaVersion(context.db);

    // Windows will not rename a file that this process has open, so the
    // connection has to go before the replacement. The version check above
    // needed it open, and a failure below must not leave the app without a
    // database.
    context.closeDb();

    try {
      const outcome = restoreBackup(
        context.paths.databasePath,
        request.path,
        { expectedSchemaVersion },
        context.databaseKey,
      );
      log.warn("Backup restored", { from: request.path, safetyBackup: outcome.safetyBackupPath });

      // The file underneath the connection is now a different database, so
      // the only safe way to continue is a fresh process.
      setImmediate(() => {
        app.relaunch();
        app.exit(0);
      });

      return { ok: true, data: deps.getMigrationStatus() };
    } catch (error) {
      context.openDb();
      log.error("Restore failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return fail("RESTORE_FAILED", "The restore failed. Your existing data has not been changed.");
    }
  });

  handle<string>(IPC.diagnosticsExport, () => {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const target = join(app.getPath("desktop"), `eyerstock-diagnostics-${timestamp}.txt`);

      const info: AppInfo = {
        name: app.getName(),
        version: app.getVersion(),
        electronVersion: process.versions.electron ?? "unknown",
        chromeVersion: process.versions.chrome ?? "unknown",
        nodeVersion: process.versions.node,
        platform: `${process.platform} ${process.arch}`,
        schemaVersion: getCurrentSchemaVersion(context.db),
        locale: app.getLocale(),
        isPackaged: app.isPackaged,
      };

      const integrity = context.db.pragma("integrity_check") as { integrity_check?: unknown }[];
      const backupDir = backupDirectoryFor(deps);
      let backupFiles: string[] = [];
      try {
        backupFiles = readdirSync(backupDir)
          .filter((name) => name.toLowerCase().endsWith(".db"))
          .map((name) => basename(name));
      } catch {
        backupFiles = [];
      }

      // Only tables that still exist. Migration 018 removed serial_units and
      // audit_log, and counting a missing table would throw - in the very
      // report a shopkeeper sends when something is already going wrong.
      const counts = {
        products: countOf(context.db, "products"),
        parties: countOf(context.db, "parties"),
        documents: countOf(context.db, "documents"),
        documentLines: countOf(context.db, "document_lines"),
        payments: countOf(context.db, "payments"),
        stockMovements: countOf(context.db, "stock_movements"),
      };

      const contents = [
        "EyerStock diagnostics",
        `Generated: ${new Date().toISOString()}`,
        "",
        "## App",
        JSON.stringify(info, null, 2),
        "",
        "## Encryption",
        `Mode: ${context.encryption.mode}`,
        "",
        "## Database integrity",
        JSON.stringify(integrity, null, 2),
        "",
        "## Row counts",
        JSON.stringify(counts, null, 2),
        "",
        "## Paths",
        `Database: ${context.paths.databasePath}`,
        `Logs: ${context.paths.logsDir}`,
        `Backups: ${backupDir}`,
        `Exports: ${context.paths.exportsDir}`,
        "",
        "## Settings",
        JSON.stringify(deps.settings.load(), null, 2),
        "",
        `## Backup files (${backupFiles.length})`,
        backupFiles.join("\n") || "(none)",
        "",
        "## Recent log tail",
        readLogTail(context.paths.logsDir),
      ].join("\n");

      writeFileSync(target, contents, "utf8");

      log.info("Diagnostics exported", { target });
      return { ok: true, data: target };
    } catch (error) {
      log.error("Diagnostics export failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return fail("EXPORT_FAILED", "Could not write the diagnostics file to your Desktop.");
    }
  });

  /* ------------------------------------------------------------- updates -- */

  /**
   * Ask for an update.
   *
   * Any signed-in user may check: it is one request to the release server and
   * it changes nothing on this computer. Downloading and installing are
   * different - they replace the application and close it - so they are an
   * administrator's job, the same way restoring a backup is.
   */
  handle<UpdateStatus>(IPC.updateCurrent, () => ({
    ok: true,
    data: deps.updater.status(),
  }));

  handle<UpdateStatus>(IPC.updateCheck, async () => {
    try {
      deps.session.require("settings", "view");
    } catch {
      return fail("FORBIDDEN", "Sign in to check for updates.");
    }

    return { ok: true, data: await deps.updater.check() };
  });

  handle<UpdateStatus>(IPC.updateDownload, async () => {
    try {
      deps.session.require("settings", "edit");
    } catch {
      return fail("FORBIDDEN", "Only an administrator can install an update.");
    }

    return { ok: true, data: await deps.updater.download() };
  });

  handle<UpdateStatus>(IPC.updateInstall, () => {
    try {
      deps.session.require("settings", "edit");
    } catch {
      return fail("FORBIDDEN", "Only an administrator can install an update.");
    }

    // The app is about to close, so this never returns to the renderer - the
    // window is gone by the time the installer has run. The status is
    // returned anyway so the shape of the answer is the same as the others.
    deps.updater.install();
    return { ok: true, data: deps.updater.status() };
  });

  /* ---------------------------------------------------------------- rpc -- */

  const rpcDeps: RpcDeps = {
    log,
    // A getter, not the handle as it stands now: a restore closes the
    // connection and opens a new one, and every RPC must see the live one.
    get db() {
      return context.db;
    },
    session: deps.session,
    now: () => new Date(),
    loadSettings: () => deps.settings.load(),
    updateSettings: (patch) => deps.settings.update(patch),
    refreshSettings: () => deps.settings.refresh(),
    exportDir: () => context.paths.exportsDir,
    avatarsDir: () => context.paths.avatarsDir,
    token: deps.token,
    saveDevSession: (userId: number, roleId: number | null) =>
      deps.saveDevSession(userId, roleId),
    loadDevSession: () => deps.loadDevSession(),
    canRestoreDevSession: () => deps.canRestoreDevSession(),
    clearDevSession: () => deps.clearDevSession(),
  };

  handle(IPC.rpc, async (payload) => {
    const request = payload as { method?: unknown; payload?: unknown; token?: unknown };

    if (typeof request !== "object" || request === null) {
      return fail("BAD_REQUEST", "Malformed request.");
    }

    // Constant-ish comparison is unnecessary here: the token is not a secret
    // guessable over many attempts, it only stops a foreign page reusing the
    // bridge it was never given.
    if (request.token !== deps.token) {
      log.warn("Rejected an RPC call with an invalid session token", {
        method: typeof request.method === "string" ? request.method : "(unknown)",
      });
      return fail("BAD_TOKEN", "This request did not come from an open EyerStock window.");
    }

    if (typeof request.method !== "string") {
      return fail("BAD_REQUEST", "No operation was named.");
    }

    // The method name arrives as a plain string over the bridge; `dispatchRpc`
    // validates it against the registered table and returns a typed failure for
    // anything unknown.
    return dispatchRpc(request.method, request.payload, rpcDeps, app.getVersion());
  });

  /* -------------------------------------------------------------- print -- */

  handle<string>(IPC.printDocument, async (payload) => {
    const parsed = printHtmlSchema.safeParse(payload);
    if (!parsed.success) return fail("BAD_REQUEST", validationMessage(parsed.error));

    const session = deps.session.currentOrNull();
    if (session === null) return fail("UNAUTHENTICATED", "Please sign in again.");

    try {
      const outcome = await printHtml(
        parsed.data.html,
        parsed.data.options,
        log,
        parsed.data.options.footerLabel ?? "",
      );
      return { ok: true, data: outcome.path ?? "printed" };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (detail === "cancelled") return fail("CANCELLED", "Printing was cancelled.");
      return fail("PRINT_FAILED", detail);
    }
  });

  handle<string>(IPC.savePdf, async (payload) => {
    const parsed = savePdfSchema.safeParse(payload);
    if (!parsed.success) return fail("BAD_REQUEST", validationMessage(parsed.error));

    if (deps.session.currentOrNull() === null) {
      return fail("UNAUTHENTICATED", "Please sign in again.");
    }

    try {
      const path = await saveHtmlAsPdf(
        parsed.data.html,
        parsed.data.suggestedName,
        context.paths.exportsDir,
        log,
        parsed.data.footerLabel ?? "",
      );
      return { ok: true, data: path };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (detail === "cancelled") return fail("CANCELLED", "Saving was cancelled.");
      return fail("PDF_FAILED", detail);
    }
  });

  handle<{ opened: boolean }>(IPC.openExternal, (payload) => {
    const parsed = openExternalSchema.safeParse(payload);
    if (!parsed.success) return fail("BAD_REQUEST", "That link is not valid.");
    return { ok: true, data: openExternalSafely(parsed.data.url, log) };
  });
}

function countOf(db: AppContext["db"], table: string): number {
  // Table names are literals from this file, never user input.
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
  return row.count;
}

export { loadFileSettings, saveFileSettings } from "./settings";
