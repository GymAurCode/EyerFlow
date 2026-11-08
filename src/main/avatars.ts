/**
 * Profile pictures.
 *
 * The same approach the company logo already uses, for the same reasons: the
 * renderer never gets to choose a path. It asks for a file, the main process
 * copies the chosen image into the application's own `avatars` folder, and the
 * database keeps only the file *name*.
 *
 * Keeping a name rather than a full path is deliberate. The data directory can
 * move - a different machine, a restored backup - and a stored absolute path
 * would break silently and show an empty avatar forever. It also means a tampered
 * row cannot point the reader at an arbitrary file on the disk: the reader only
 * ever joins a name it has already checked against a fixed pattern, and then
 * only inside the avatars folder.
 *
 * The image is handed to the renderer as a data URL, mirroring
 * `companyLogoDataUrl`. Nothing in the app can read an arbitrary `file://` URL
 * out of the renderer, and an inline URL survives being handed to a sandboxed
 * print window.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";

/** Folder name inside the app's user data directory. */
export const AVATARS_DIR = "avatars";

/**
 * Formats accepted. Kept in step with `SettingsService.readLogo`, so the picture
 * on a profile and the logo on an invoice are the same set of formats.
 */
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

/**
 * 2 MB.
 *
 * Generous for a profile picture and small enough that inlining the image over
 * IPC on every session read stays cheap. A 2 MB photo is far larger than any
 * sensible avatar.
 */
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

/** Errors the renderer turns into a message on the profile page. */
export class AvatarError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AvatarError";
  }
}

export function avatarMimeFor(path: string): string | null {
  return MIME_BY_EXTENSION[extname(path).toLowerCase()] ?? null;
}

/**
 * Reject anything that is not one of our own generated names.
 *
 * Generated names are `<digits>.<png|jpg|jpeg|webp>` and nothing else. Refusing
 * everything else is what keeps `resolveAvatarPath` from ever walking out of the
 * avatars folder, whatever is in the database.
 */
export function isValidAvatarFileName(name: string): boolean {
  return /^\d+\.(png|jpe?g|webp)$/i.test(basename(name)) && name === basename(name);
}

/** Absolute path for a stored name, or null if the name is not one of ours. */
export function resolveAvatarPath(avatarsDir: string, name: string | null): string | null {
  if (name === null || name.length === 0) return null;
  if (!isValidAvatarFileName(name)) return null;
  const full = join(avatarsDir, name);
  return existsSync(full) ? full : null;
}

/**
 * Inline a stored avatar for the renderer.
 *
 * Returns null rather than throwing for a missing or oversized file: a missing
 * picture must never be the reason a page fails to load, and the initials avatar
 * is a perfectly good answer.
 */
export function readAvatarDataUrl(avatarsDir: string, name: string | null): string | null {
  const full = resolveAvatarPath(avatarsDir, name);
  if (full === null) return null;

  const mime = avatarMimeFor(full);
  if (mime === null) return null;

  try {
    const { size } = statSync(full);
    if (size > MAX_AVATAR_BYTES) return null;
    return `data:${mime};base64,${readFileSync(full).toString("base64")}`;
  } catch {
    return null;
  }
}

/**
 * Copy a chosen image into the avatars folder and return the name to store.
 *
 * `previousName` is deleted afterwards so replacing a picture does not leave the
 * old file behind forever. It is deleted only after the copy has succeeded, so a
 * failed replace still leaves the user with the picture they already had.
 */
export function storeAvatar(
  avatarsDir: string,
  userId: number,
  sourcePath: string,
  previousName: string | null,
): string {
  const mime = avatarMimeFor(sourcePath);
  if (mime === null) {
    throw new AvatarError("Choose a PNG, JPG or WebP image.");
  }

  let size: number;
  try {
    size = statSync(sourcePath).size;
  } catch {
    throw new AvatarError("That image could not be read. Try choosing it again.");
  }

  if (size > MAX_AVATAR_BYTES) {
    throw new AvatarError("That image is larger than 2 MB. Choose a smaller one.");
  }

  mkdirSync(avatarsDir, { recursive: true });

  // One name per user, derived from their id, so the folder cannot grow without
  // bound as somebody tries pictures on and off.
  const name = `${String(userId)}.${mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg"}`;
  const target = join(avatarsDir, name);

  try {
    copyFileSync(sourcePath, target);
  } catch {
    throw new AvatarError("That image could not be saved. Check the folder is writable.");
  }

  if (previousName !== null && previousName !== name && isValidAvatarFileName(previousName)) {
    try {
      rmSync(join(avatarsDir, previousName), { force: true });
    } catch {
      /* A stale file is untidy, not broken. The new picture is already saved. */
    }
  }

  return name;
}

/** Remove a stored avatar. Used when the user chooses "remove photo". */
export function deleteAvatar(avatarsDir: string, name: string | null): void {
  if (name === null || !isValidAvatarFileName(name)) return;
  try {
    rmSync(join(avatarsDir, name), { force: true });
  } catch {
    /* Nothing to do: the row is being cleared either way. */
  }
}
