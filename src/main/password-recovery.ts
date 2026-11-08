/**
 * Forgotten-password recovery from the login screen.
 *
 * EyerCall issues two fixed recovery codes to the shop. They are checked here,
 * in the main process, so the renderer never receives them and the shared
 * bundle cannot disclose them. A successful check is followed by the ordinary
 * password policy and the ordinary password write, so recovery cannot create a
 * weaker password than any other path.
 *
 * The codes are recovery secrets for an offline desktop app, not encryption
 * keys: anyone who can read the packaged main bundle can eventually find them.
 * Rotating them means changing this list and rebuilding the app.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { SqliteDatabase } from "../data/connection";
import { DEFAULT_LOCKOUT, evaluateLockout, lockExpiryIso } from "../domain/auth";
import type { RecoverPasswordRequest } from "../shared/types";
import type { AuditActor } from "./audit-writer";
import { resetPassword } from "./repositories/users";

/** The codes EyerCall gives a customer for a forgotten local password. */
const RECOVERY_CODES = ["UMX", "EYER-CALL"] as const;

/** One message for both a wrong username and a wrong code, on purpose. */
const INVALID_MESSAGE =
  "The username or secret code is not valid. Check the code from EyerCall and try again.";

/** A shop-facing recovery failure. */
export class PasswordRecoveryError extends Error {
  public readonly field: string | undefined;

  public constructor(message: string, field?: string) {
    super(message);
    this.name = "PasswordRecoveryError";
    this.field = field;
  }
}

/** Recovery is not a sign-in: the audit trail says who really did it. */
const RECOVERY_ACTOR: AuditActor = { id: null, name: "Password recovery" };

function digest(value: string): Buffer {
  return createHash("sha256").update(value.trim().toUpperCase(), "utf8").digest();
}

/**
 * True when the code is one EyerCall issued.
 *
 * The input is trimmed and uppercased so a customer can type `umx` or paste
 * ` EYER-CALL `. Every candidate is compared, without an early return, and the
 * comparison is timing-safe: the length and content of the code are not leaked
 * through how long the check takes.
 */
export function isRecoveryCode(value: string): boolean {
  const candidate = digest(value);
  let matched = false;

  for (const code of RECOVERY_CODES) {
    if (timingSafeEqual(candidate, digest(code))) matched = true;
  }

  return matched;
}

interface RecoveryRow {
  readonly id: number;
  readonly is_active: number;
  readonly failed_attempts: number;
  readonly locked_until: string | null;
}

/**
 * Count a wrong code against the account's normal lockout.
 *
 * Recovery deliberately does not refuse a currently locked account: the whole
 * point of the flow is to let the owner back in, and the correct code still
 * clears the lock. Wrong guesses extend the same counter login uses, so the
 * dialog cannot become an unlimited code oracle. An existing lock is left
 * alone rather than extended on every guess.
 */
function recordWrongCode(db: SqliteDatabase, row: RecoveryRow, now: Date, nowIso: string): void {
  if (evaluateLockout(row.failed_attempts, row.locked_until, now).locked) return;

  const attempts = row.failed_attempts + 1;
  const nowLocked = attempts >= DEFAULT_LOCKOUT.threshold;

  db.prepare(
    `UPDATE users
        SET failed_attempts = ?, locked_until = ?, updated_at = ?
      WHERE id = ?`,
  ).run(attempts, nowLocked ? lockExpiryIso(now) : null, nowIso, row.id);
}

/**
 * Reset a forgotten password when the caller knows an EyerCall secret code.
 *
 * The account is looked up case-insensitively, must still be active, and the
 * new password goes through the same policy and hash as `users.resetPassword`.
 * Nothing about the user is returned: this runs before authentication, so it
 * must not hand the login screen a profile, a role or a session.
 */
export function recoverPassword(
  context: { readonly db: SqliteDatabase; readonly nowIso: string },
  request: RecoverPasswordRequest,
): void {
  const { db } = context;
  const now = new Date(context.nowIso);

  // Checked before the lookup so an unknown username and a known one with a
  // wrong code do comparable work.
  const codeAccepted = isRecoveryCode(request.secretCode);

  const row = db
    .prepare(
      `SELECT id, is_active, failed_attempts, locked_until
         FROM users
        WHERE username = ? COLLATE NOCASE`,
    )
    .get(request.username) as RecoveryRow | undefined;

  if (row === undefined || row.is_active !== 1 || !codeAccepted) {
    if (row !== undefined) recordWrongCode(db, row, now, context.nowIso);
    throw new PasswordRecoveryError(INVALID_MESSAGE);
  }

  // One transaction for the hash change and the must-change flag; if the new
  // password breaks the policy, neither is written and the code stays usable.
  db.transaction(() => {
    resetPassword(
      { db, actor: RECOVERY_ACTOR, nowIso: context.nowIso },
      row.id,
      request.newPassword,
      false,
      "recoverPassword",
    );
  })();
}
