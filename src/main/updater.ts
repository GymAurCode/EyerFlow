/**
 * Application updates.
 *
 * The updater is the main process's job and nobody else's. It replaces the
 * installed application, which means writing to the installation directory -
 * something the renderer has no access to and no business having - and it
 * needs the signed release manifest that electron-builder writes beside the
 * executable. The renderer asks for things and is told what is happening.
 *
 * Three rules:
 *
 *  1. Nothing happens without being asked for. The update is never fetched
 *     behind the user's back and never installed while they are working: a
 *     shopkeeper halfway through an invoice should not have the app close on
 *     them. The one automatic part is the *check*, which is a single request
 *     to the release server and changes nothing on disk.
 *  2. Every state change is pushed to the renderer, so a download that takes
 *     a minute reports its progress on the screen that started it.
 *  3. A build that cannot check for updates says so rather than failing. A
 *     development build has no release manifest, so the updater is
 *     unavailable there - not broken.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import { autoUpdater } from "electron-updater";
import type { UpdateState, UpdateStatus } from "../shared/ipc";
import type { Logger } from "./logger";

export interface UpdateService {
  /** Ask the release server whether a newer version exists. */
  check(): Promise<UpdateStatus>;
  /** Download the installer for the version that was found. */
  download(): Promise<UpdateStatus>;
  /** Close the app and install the downloaded update. */
  install(): void;
  /** The current state, for a screen that asks without waiting. */
  status(): UpdateStatus;
  /** Listen for state changes. Returns a function that stops listening. */
  onChange(listener: (status: UpdateStatus) => void): () => void;
  dispose(): void;
}

/**
 * The release manifest electron-builder writes into the packaged app.
 *
 * It says where updates come from, which is the one piece of information the
 * renderer cannot work out for itself: the release page a user can be sent to
 * to read what changed before installing anything.
 */
interface UpdateManifest {
  readonly provider: string | null;
  readonly owner: string | null;
  readonly repo: string | null;
  readonly url: string | null;
}

/**
 * Read `app-update.yml` from the packaged resources.
 *
 * The file is a flat list of `key: value` lines written by electron-builder,
 * so it is read line by line rather than through a YAML parser the app would
 * otherwise not need. A missing or unreadable file is not an error: it only
 * means there is no release page to offer.
 */
function readManifest(): UpdateManifest {
  const empty: UpdateManifest = { provider: null, owner: null, repo: null, url: null };

  let text: string;
  try {
    text = readFileSync(join(process.resourcesPath, "app-update.yml"), "utf8");
  } catch {
    return empty;
  }

  const values = new Map<string, string>();
  for (const line of text.split("\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key.length > 0 && value.length > 0) values.set(key, value);
  }

  return {
    provider: values.get("provider") ?? null,
    owner: values.get("owner") ?? null,
    repo: values.get("repo") ?? null,
    url: values.get("url") ?? null,
  };
}

/**
 * The release page for the versions this app is served from, if the manifest
 * says where releases live.
 *
 * GitHub releases have a page a human can read; a generic file server has a
 * URL to the manifest instead. Either way it is a link, not something the
 * updater depends on.
 */
function releasePage(manifest: UpdateManifest): string | null {
  if (manifest.provider === "github" && manifest.owner !== null && manifest.repo !== null) {
    return `https://github.com/${manifest.owner}/${manifest.repo}/releases`;
  }
  if (manifest.provider === "generic" && manifest.url !== null) {
    return manifest.url;
  }
  return null;
}

/**
 * Turn whatever the updater logged into a line of text.
 *
 * The updater logs strings, errors and occasionally objects, and the app's
 * logger takes a string. Anything that is not text is described rather than
 * stringified blindly, so a log line never reads "[object Object]".
 */
function describeLog(message: unknown): string {
  if (typeof message === "string") return message;
  if (message instanceof Error) return message.message;
  if (message === undefined || message === null) return "";
  try {
    return JSON.stringify(message) ?? "";
  } catch {
    return "the updater logged something that could not be read";
  }
}

/**
 * A message the reader can act on, rather than a stack trace.
 *
 * The updater fails for ordinary reasons - no network, a release that has
 * been withdrawn, a proxy that blocks the request - and none of them should
 * be reported as "an error occurred".
 */
function describeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ENETUNREACH/i.test(message)) {
    return "Could not reach the update server. Check the internet connection and try again.";
  }
  if (/certificate|SSL|TLS/i.test(message)) {
    return "The update server's security certificate was refused. Check the date and time on this computer.";
  }
  if (/app-update\.yml|not packaged|dev update config/i.test(message)) {
    return "This build has no update information. Ask your supplier for a new installer.";
  }
  if (/404|not found/i.test(message)) {
    return "The release could not be found. The application is up to date.";
  }
  if (message.length > 0) return message;
  return "The update could not be completed.";
}

export interface UpdateServiceDeps {
  readonly log: Logger;
}

export function createUpdateService(deps: UpdateServiceDeps): UpdateService {
  const { log } = deps;

  /**
   * Only a packaged build can update itself.
   *
   * The updater reads `app-update.yml` from the resources folder, which only
   * exists in a packaged build, and compares the result against a release on
   * the server. In development there is nothing to compare against, so the
   * whole feature reports itself as unavailable instead of throwing.
   */
  const supported = app.isPackaged;
  const manifest = supported ? readManifest() : null;
  const releasesUrl = manifest === null ? null : releasePage(manifest);

  const listeners = new Set<(status: UpdateStatus) => void>();
  let checking = false;

  let state: UpdateState = "idle";
  let latestVersion: string | null = null;
  let progressPercent: number | null = null;
  let message: string | null = null;
  let checkedAtIso: string | null = null;

  const currentStatus = (): UpdateStatus => ({
    supported,
    state,
    currentVersion: app.getVersion(),
    latestVersion,
    progressPercent,
    message,
    releaseUrl: releasesUrl,
    checkedAtIso,
  });

  /**
   * The last snapshot that was sent.
   *
   * The updater reports download progress on every chunk it receives, which
   * is far more often than a person can read. Nothing is sent until the
   * rounded percentage actually changes, so the screen is not asked to
   * re-render thirty times a second for a bar that moves one pixel at a time.
   */
  let lastSent: UpdateStatus | null = null;

  const notify = (): void => {
    const snapshot = currentStatus();
    const previous = lastSent;
    if (
      previous !== null &&
      previous.state === snapshot.state &&
      previous.latestVersion === snapshot.latestVersion &&
      previous.progressPercent === snapshot.progressPercent &&
      previous.message === snapshot.message &&
      previous.checkedAtIso === snapshot.checkedAtIso
    ) {
      return;
    }
    lastSent = snapshot;

    for (const listener of listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        // A listener that throws must not stop the others from being told.
        log.error("An update listener failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  const setState = (next: UpdateState, extra: Partial<UpdateStatus> = {}): void => {
    state = next;
    if (extra.latestVersion !== undefined) latestVersion = extra.latestVersion;
    if (extra.progressPercent !== undefined) progressPercent = extra.progressPercent;
    if (extra.message !== undefined) message = extra.message;
    if (extra.checkedAtIso !== undefined) checkedAtIso = extra.checkedAtIso;
    notify();
  };

  if (supported) {
    // The download is never automatic. The user is told an update exists and
    // decides whether to fetch it.
    autoUpdater.autoDownload = false;

    // Nor is the install: a downloaded update waits until the user asks for
    // it, so the app never closes while somebody is mid-invoice.
    autoUpdater.autoInstallOnAppQuit = false;

    // The updater's own chatter goes into the app's log file, which is what a
    // support request will ask for.
    autoUpdater.logger = {
      info: (message?: unknown) => {
        log.info(describeLog(message));
      },
      warn: (message?: unknown) => {
        log.warn(describeLog(message));
      },
      error: (message?: unknown) => {
        log.error(describeLog(message));
      },
    };

    autoUpdater.on("checking-for-update", () => {
      setState("checking");
    });

    autoUpdater.on("update-available", (info) => {
      log.info("An update is available", {
        current: app.getVersion(),
        latest: info.version,
      });
      setState("available", {
        latestVersion: info.version,
        progressPercent: null,
        message: null,
        checkedAtIso: new Date().toISOString(),
      });
    });

    autoUpdater.on("update-not-available", () => {
      log.info("The application is up to date", { version: app.getVersion() });
      setState("upToDate", {
        latestVersion: app.getVersion(),
        progressPercent: null,
        message: null,
        checkedAtIso: new Date().toISOString(),
      });
    });

    autoUpdater.on("download-progress", (progress) => {
      setState("downloading", { progressPercent: Math.round(progress.percent) });
    });

    autoUpdater.on("update-downloaded", (event) => {
      log.info("The update has been downloaded", { file: event.downloadedFile });
      setState("downloaded", {
        latestVersion: event.version,
        progressPercent: 100,
        message: null,
      });
    });

    autoUpdater.on("error", (error) => {
      log.error("The update failed", { error: error.message });
      setState("error", {
        progressPercent: null,
        message: describeFailure(error),
      });
    });
  }

  return {
    async check(): Promise<UpdateStatus> {
      if (!supported) return currentStatus();

      // One check at a time. A second request while the first is in flight
      // would ask the release server the same question twice and race with
      // the first answer.
      if (checking) return currentStatus();
      checking = true;

      try {
        await autoUpdater.checkForUpdates();
      } catch (error) {
        // The error event above has already set the state; this catch keeps a
        // rejected promise from escaping as an unhandled rejection.
        log.error("The update check failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        checking = false;
        if (state === "checking") {
          setState("upToDate", { checkedAtIso: new Date().toISOString() });
        }
      }

      return currentStatus();
    },

    async download(): Promise<UpdateStatus> {
      if (!supported) return currentStatus();

      try {
        await autoUpdater.downloadUpdate();
      } catch (error) {
        log.error("The update download failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        setState("error", {
          progressPercent: null,
          message: describeFailure(error),
        });
      }

      return currentStatus();
    },

    install(): void {
      if (!supported) return;

      // Only a downloaded update is installed. Installing without one would
      // close the app and do nothing.
      if (state !== "downloaded") {
        log.warn("An install was asked for with no downloaded update", { state });
        return;
      }

      log.info("Installing the update and restarting", { version: latestVersion });

      // Silent, because the installer asks two questions - "keep your data?"
      // and "the app is still running" - and neither of them applies to an
      // update. The custom NSIS script recognises an update and skips both.
      //
      // The second argument is "start the app again afterwards". Without it
      // the installer would leave the shop with an application that is not
      // running and no sign that anything had happened.
      autoUpdater.quitAndInstall(true, true);
    },

    status(): UpdateStatus {
      return currentStatus();
    },

    onChange(listener: (status: UpdateStatus) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    dispose(): void {
      listeners.clear();
      if (!supported) return;
      autoUpdater.removeAllListeners();
    },
  };
}
