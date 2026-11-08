/**
 * Preload bridge.
 *
 * Exposes a small, explicit API on `window.api` and nothing else. No Node
 * module, no `ipcRenderer`, and no filesystem handle ever reaches the page, so a
 * cross-site-scripting bug in the renderer cannot escalate beyond the handful of
 * validated operations listed here.
 *
 * This file must not `require` anything of its own. The window runs with
 * `sandbox: true`, and a sandboxed preload gets a polyfilled `require` that
 * resolves Electron's built-in modules only - it cannot load a relative file.
 * Importing the shared channel names at runtime therefore threw during preload,
 * `exposeInMainWorld` never ran, and the whole renderer came up with
 * `window.api` undefined ("Cannot read properties of undefined (reading
 * 'invoke')"). The channel names are listed below instead, and
 * `tests/preload.test.ts` fails if they ever drift from `shared/ipc.ts`.
 *
 * Types are free to import: they are erased at compile time and produce no
 * `require` in the emitted file.
 */

import { contextBridge, ipcRenderer } from "electron";
import type {
  ApiResult,
  MinhaApi,
  RpcMethod,
  RpcRequestOf,
  RpcResponseOf,
  UpdateStatus,
} from "../shared/ipc";

/**
 * IPC channel names, mirroring `IPC` in `shared/ipc.ts`.
 *
 * Inlined deliberately - see the note at the top of this file. Kept honest by
 * `tests/preload.test.ts`, which compares these against the shared map in both
 * directions so a channel added on one side and forgotten on the other fails the
 * build rather than the app.
 */
const CHANNEL = {
  appInfo: "app:info",
  dbMigrateStatus: "db:migrateStatus",
  backupRunNow: "backup:runNow",
  backupChooseFolder: "backup:chooseFolder",
  backupList: "backup:list",
  backupVerify: "backup:verify",
  backupRestore: "backup:restore",
  diagnosticsExport: "diagnostics:export",
  rpc: "api:invoke",
  pickFile: "dialog:pickFile",
  pickImage: "dialog:pickImage",
  printDocument: "print:document",
  savePdf: "print:savePdf",
  openExternal: "shell:openExternal",
  updateCheck: "update:check",
  updateDownload: "update:download",
  updateInstall: "update:install",
  updateCurrent: "update:current",
  updateStatus: "update:status",
} as const;

/**
 * Per-session token, passed from the main process via `additionalArguments`.
 *
 * Only this window's renderer knows it, so an injected script that somehow
 * obtained `ipcRenderer.invoke` still cannot use the RPC channel.
 */
function readToken(): string {
  const prefix = "--eyerstock-token=";
  const argument = process.argv.find((value) => value.startsWith(prefix));
  return argument === undefined ? "" : argument.slice(prefix.length);
}

const token = readToken();

/**
 * Unwrap an ApiResult into a plain promise, so renderer code can use
 * try/catch for transport failures and check `ok` for domain failures.
 */
async function call<T>(channel: string, payload?: unknown): Promise<ApiResult<T>> {
  return (await ipcRenderer.invoke(channel, payload)) as ApiResult<T>;
}

const api: MinhaApi = {
  getAppInfo: () => call(CHANNEL.appInfo),
  getMigrationStatus: () => call(CHANNEL.dbMigrateStatus),

  runBackupNow: () => call(CHANNEL.backupRunNow),
  chooseBackupFolder: () => call(CHANNEL.backupChooseFolder),
  listBackups: () => call(CHANNEL.backupList),
  verifyBackup: (path: string) => call(CHANNEL.backupVerify, path),
  restoreBackup: (path: string, confirmation: string) =>
    call(CHANNEL.backupRestore, { path, confirmation }),

  exportDiagnostics: () => call(CHANNEL.diagnosticsExport),

  pickFile: (purpose) => call(CHANNEL.pickFile, purpose),
  pickImage: (purpose) => call(CHANNEL.pickImage, purpose),

  invoke: <M extends RpcMethod>(method: M, payload: RpcRequestOf<M>) =>
    call<RpcResponseOf<M>>(CHANNEL.rpc, { method, payload, token }),

  printHtml: (html: string, options) => call(CHANNEL.printDocument, { html, options }),
  saveHtmlAsPdf: (html: string, suggestedName: string, options) =>
    call(CHANNEL.savePdf, { html, suggestedName, ...options }),
  openExternal: (url: string) => call(CHANNEL.openExternal, { url }),

  currentUpdate: () => call(CHANNEL.updateCurrent),
  checkForUpdate: () => call(CHANNEL.updateCheck),
  downloadUpdate: () => call(CHANNEL.updateDownload),
  installUpdate: () => call(CHANNEL.updateInstall),

  /**
   * The one push channel the renderer listens to.
   *
   * The listener is passed the raw Electron event, so it is dropped here
   * rather than in the page: the renderer gets the status and nothing else,
   * and cannot reach the sender.
   */
  onUpdateStatus: (listener: (status: UpdateStatus) => void) => {
    const handler = (_event: unknown, status: UpdateStatus): void => {
      listener(status);
    };
    ipcRenderer.on(CHANNEL.updateStatus, handler);
    return () => {
      ipcRenderer.removeListener(CHANNEL.updateStatus, handler);
    };
  },
};

contextBridge.exposeInMainWorld("api", Object.freeze(api));
