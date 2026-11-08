/**
 * Database encryption.
 *
 * The database file is encrypted with SQLCipher (via the
 * `better-sqlite3-multiple-ciphers` build) and the passphrase is protected by
 * Electron's `safeStorage`, which on Windows wraps the key with DPAPI and ties
 * it to the logged-in Windows user. Consequences worth stating plainly:
 *
 *  - The file cannot be read by another tool without the key, so a stolen or
 *    copied database does not leak customer names, phones and TRNs.
 *  - The key is machine- and user-bound. Restoring a backup onto a different
 *    PC needs the passphrase, which is why the passphrase is also written to a
 *    small key file in the app's data folder with safeStorage protection
 *    rather than being derived from nothing.
 *
 * If safeStorage is unavailable (a Linux box with no keyring), the app falls
 * back to a key file with restrictive permissions and says so at startup, so
 * the operator knows encryption is weaker on that machine.
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { safeStorage } from "electron";
import {
  applyPragmas,
  checkIntegrity,
  copyDatabaseContents,
  openForInspection,
  resolveDatabasePath,
} from "./connection";
import type { SqliteDatabase } from "./connection";

const KEY_FILE = "db-key.bin";
const KEY_LENGTH = 32;

export type EncryptionMode = "safeStorage" | "keyFile" | "none";

export interface EncryptionState {
  readonly mode: EncryptionMode;
  readonly keyFilePath: string;
  readonly warning: string | null;
}

let state: EncryptionState | null = null;

/**
 * Recognise a key file written as plain text, and recover the key from it.
 *
 * The key file format has to be self-describing because both of its states are
 * legitimate and neither can be assumed. A run where hardware key protection
 * was unavailable writes the key as text; a run where it was available writes
 * DPAPI ciphertext. There have also been versions of this app that started
 * before Electron's `ready` event, where `safeStorage` was unavailable purely
 * because the app had not finished starting - those wrote text too, on machines
 * that would otherwise have written ciphertext.
 *
 * Returns null when the bytes are not one of our keys, so a genuinely corrupt
 * file is reported rather than silently reinterpreted as a key.
 */
function readPlaintextKey(bytes: Buffer): string | null {
  const text = bytes.toString("utf8");

  // Binary ciphertext decodes to U+FFFD replacement characters rather than
  // itself, so this is the cheapest way to rule it out.
  if (text.includes("\uFFFD")) return null;

  const trimmed = text.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) return null;

  const decoded = Buffer.from(trimmed, "base64");
  if (decoded.length !== KEY_LENGTH) return null;
  // Round-trip check rejects sloppy base64 that decodes to the right number of
  // bytes by coincidence.
  if (decoded.toString("base64") !== trimmed) return null;

  return trimmed;
}

/**
 * Resolve (or create) the database passphrase.
 *
 * Called once before the database is opened. The value is cached in the main
 * process only; it is never written to the renderer or to a log line.
 */
export function resolveEncryptionKey(userDataDir: string): { key: string; state: EncryptionState } {
  const keyFilePath = join(userDataDir, KEY_FILE);

  let existing: Buffer | null = null;
  if (existsSync(keyFilePath)) {
    existing = readFileSync(keyFilePath);
  }

  const available = isSafeStorageAvailable();

  let secret: string;
  let mode: EncryptionMode;

  if (existing === null) {
    secret = randomBytes(KEY_LENGTH).toString("base64");
    writeKeyFile(keyFilePath, secret, available);
    mode = available ? "safeStorage" : "keyFile";
  } else {
    const plaintext = readPlaintextKey(existing);

    if (available) {
      if (plaintext !== null) {
        // A key file written as text, either because key protection was
        // unavailable or because an earlier build started before Electron was
        // ready. Adopt it - it is the key this database was encrypted with - and
        // rewrite it encrypted so it is protected from now on. Refusing here
        // would strand a working installation over a change the user never made.
        secret = plaintext;
        writeKeyFile(keyFilePath, secret, true);
        mode = "safeStorage";
      } else {
        secret = safeStorage.decryptString(existing);
        mode = "safeStorage";
      }
    } else if (plaintext !== null) {
      secret = plaintext;
      mode = "keyFile";
    } else {
      // Key protection is off but the key file is ciphertext: it was written by
      // this Windows account's key store, which is not reachable right now.
      // Using the raw bytes as a key would produce a baffling "wrong key"
      // failure, so the real cause is named instead.
      throw new Error(
        "The database key is protected by this Windows account's key store, which is not " +
          "available right now. Sign in as the Windows user who installed the app, or " +
          "restore a backup taken on that same machine and user.",
      );
    }
  }

  const warning =
    mode === "keyFile"
      ? "This Windows account does not offer hardware-backed key protection, so the database key " +
        "is stored in a file. Anyone with access to this Windows account and the data folder can " +
        "read the database."
      : null;

  state = { mode, keyFilePath, warning };

  return { key: secret, state };
}

export function encryptionState(): EncryptionState | null {
  return state;
}

function isSafeStorageAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    // safeStorage throws before app ready in some environments; treat that as
    // unavailable rather than letting startup fail.
    return false;
  }
}

function writeKeyFile(path: string, secret: string, encrypt: boolean): void {
  mkdirSync(dirname(path), { recursive: true });

  if (encrypt) {
    const encrypted = safeStorage.encryptString(secret);
    writeFileSync(path, encrypted, { mode: 0o600 });
    return;
  }

  writeFileSync(path, secret, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows does not honour POSIX modes; the ACL inherited from the user
    // profile is the protection there.
  }
}

/**
 * Is this file an ordinary, unencrypted SQLite database?
 *
 * Used to tell a legacy plaintext database apart from a genuinely wrong key.
 * Both produce the same "file is not a database" error when a key is applied,
 * and the two need completely different responses: one is a migration to run,
 * the other is data the operator needs to recover. Only this probe separates
 * them, because a plaintext file opens cleanly with no key at all.
 */
function isPlaintextDatabase(absolutePath: string): boolean {
  let probe: SqliteDatabase | null = null;

  try {
    probe = openForInspection(absolutePath, null, false, true);
    const row = probe.prepare("SELECT count(*) AS count FROM sqlite_master").get() as
      | { count?: unknown }
      | undefined;
    return row !== undefined;
  } catch {
    return false;
  } finally {
    if (probe !== null) {
      try {
        probe.close();
      } catch {
        /* already closed */
      }
    }
  }
}

/**
 * Convert a legacy plaintext database to an encrypted one, in place.
 *
 * Versions before encryption shipped an unencrypted file. Applying a key to one
 * makes it unreadable, so an existing installation would appear to have lost
 * all its data. The database is therefore rebuilt through SQL into a keyed file
 * and the files are swapped.
 *
 * The rebuild is needed rather than a plain file copy because this driver's
 * backup API refuses to move between a cipher database and a plain one, and it
 * exposes no export function. Copying through SQL is the portable route: the
 * destination connection is keyed, so every row written into it is encrypted as
 * it goes.
 *
 * The original file is kept beside the new one as `.plaintext-backup`, and the
 * replacement is opened and integrity-checked before anything is replaced, so a
 * failure part-way through leaves the shop's data exactly as it was.
 */
export function upgradePlaintextDatabase(absolutePath: string, key: string): string {
  const upgradePath = `${absolutePath}.encrypted`;
  const safetyPath = `${absolutePath}.plaintext-backup`;

  // Start clean so a half-finished earlier attempt cannot leak through.
  for (const stale of [upgradePath, `${upgradePath}-wal`, `${upgradePath}-shm`, `${upgradePath}-journal`]) {
    if (existsSync(stale)) unlinkSync(stale);
  }

  // The destination is the keyed connection: everything copied into it is
  // encrypted on the way in, which is what makes the output a valid database.
  // The source stays a separate plaintext connection - this driver refuses to
  // ATTACH a plain file from a keyed one, so the two can only meet here.
  const destination = openForInspection(upgradePath, key, false, false);

  try {
    const source = openForInspection(absolutePath, null, true, true);
    try {
      copyDatabaseContents(source, destination);
    } finally {
      source.close();
    }
  } catch (error) {
    destination.close();
    if (existsSync(upgradePath)) unlinkSync(upgradePath);
    throw error;
  }

  destination.close();

  // Verify before touching anything: the replacement has to open with the key
  // and pass SQLite's own integrity check, or the original stays in place.
  const verification = openForInspection(upgradePath, key, true, true);
  try {
    const result = checkIntegrity(verification);
    if (!result.ok) {
      throw new Error(`The converted database failed its integrity check: ${result.detail}`);
    }

    const violations = verification.pragma("foreign_key_check") as unknown[];
    if (violations.length > 0) {
      throw new Error(
        `The converted database has ${violations.length} referential integrity violation(s)`,
      );
    }
  } catch (error) {
    if (existsSync(upgradePath)) unlinkSync(upgradePath);
    throw error;
  } finally {
    verification.close();
  }

  // Checkpoint the source so no unencrypted pages survive the swap in a
  // sidecar file.
  const source = openForInspection(absolutePath, null, false, false);
  try {
    source.pragma("wal_checkpoint(TRUNCATE)");
  } catch {
    /* already fully checkpointed */
  } finally {
    source.close();
  }

  copyFileSync(absolutePath, safetyPath);
  renameSync(upgradePath, absolutePath);
  for (const sidecar of ["-wal", "-shm", "-journal"] as const) {
    if (existsSync(`${absolutePath}${sidecar}`)) unlinkSync(`${absolutePath}${sidecar}`);
  }

  return safetyPath;
}

/**
 * Open the encrypted database.
 *
 * The key is applied as the very first statement by `openForInspection`, before
 * any other pragma, because SQLCipher requires it immediately after opening.
 *
 * A database written by a version that predates encryption is converted to an
 * encrypted one on first sight, so upgrading the app never costs a shop its
 * history.
 */
export function openEncryptedDatabase(dbPath: string, key: string): SqliteDatabase {
  const absolutePath = resolveDatabasePath(dbPath);
  mkdirSync(dirname(absolutePath), { recursive: true });

  // Opened writable and verified immediately: an empty file and a wrong-key
  // file both defer their error to the first query otherwise. `fileMustExist`
  // is off so a first run creates the file.
  const db = openForInspection(absolutePath, key, false, false);

  try {
    const probe = db.prepare("SELECT count() AS count FROM sqlite_master").get() as
      | { count?: unknown }
      | undefined;
    if (probe === undefined) {
      throw new Error("Key check failed");
    }
  } catch {
    db.close();

    // A database created before this app had encryption is readable with no key
    // at all. Converting it is the whole difference between "upgrade" and "you
    // have lost everything", so it is worth the check.
    if (existsSync(absolutePath) && isPlaintextDatabase(absolutePath)) {
      upgradePlaintextDatabase(absolutePath, key);
      return openEncryptedDatabase(dbPath, key);
    }

    throw new Error(
      "The encrypted database could not be opened. The key file may belong to another machine " +
        "or another Windows user.",
    );
  }

  applyPragmas(db);

  return db;
}