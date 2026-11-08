/**
 * Forgotten-password recovery tests.
 *
 * These use the real setup, password hashing and login code against an
 * in-memory database. The two EyerCall codes are exercised explicitly, and the
 * failure cases assert the important property: a wrong or missing code never
 * changes the stored password.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SqliteDatabase } from "../src/data/connection";
import type { SetupRequest } from "../src/shared/types";
import { hashPassword } from "../src/domain/auth";
import { SYSTEM_ACTOR } from "../src/main/audit-writer";
import { AuthError, login, runSetup } from "../src/main/repositories/users";
import { PasswordRecoveryError, recoverPassword } from "../src/main/password-recovery";
import { freshDb, migrateInMemory } from "./helpers";

const NOW = "2026-10-27T10:00:00.000Z";
const ADMIN_PASSWORD = "OwnerPass1";
const ADMIN_USERNAME = "admin";

const SETUP: SetupRequest = {
  companyName: "Blue Water",
  companyTrn: "TRN-001",
  companyAddress: "12 Canal Road",
  companyPhone: "+92 300 0000000",
  fiscalYearStartMonth: 1,
  adminUsername: ADMIN_USERNAME,
  adminDisplayName: "Owner Name",
  adminPassword: ADMIN_PASSWORD,
};

let db: SqliteDatabase;

beforeEach(() => {
  db = freshDb();
  migrateInMemory(db);
  runSetup({ db, actor: SYSTEM_ACTOR, nowIso: NOW }, SETUP);
});

afterEach(() => {
  db.close();
});

function recover(
  username: string,
  secretCode: string,
  newPassword: string,
  target: SqliteDatabase = db,
): void {
  recoverPassword({ db: target, nowIso: NOW }, { username, secretCode, newPassword });
}

function addStaff(username: string): number {
  const role = db.prepare("SELECT id FROM roles WHERE name = 'Staff'").get() as { id: number };
  const stored = hashPassword("StaffPass1");

  return Number(
    db
      .prepare(
        `INSERT INTO users
           (username, display_name, password_hash, password_salt, role_id,
            must_change_password, is_active, failed_attempts, created_at, updated_at)
         VALUES (?, 'Front Desk', ?, ?, ?, 0, 1, 0, ?, ?)`,
      )
      .run(username, stored.hash, stored.salt, role.id, NOW, NOW).lastInsertRowid,
  );
}

describe("recovering a forgotten password", () => {
  it("resets the setup administrator with UMX and invalidates the old password", () => {
    recover(ADMIN_USERNAME, "UMX", "NewOwner123");

    expect(() => login(db, ADMIN_USERNAME, ADMIN_PASSWORD, new Date(NOW))).toThrow(AuthError);

    const outcome = login(db, ADMIN_USERNAME, "NewOwner123", new Date(NOW));
    expect(outcome.user.username).toBe(ADMIN_USERNAME);
    expect(outcome.user.roleName).toBe("Administrator");
  });

  it("accepts EYER-CALL with different casing and surrounding spaces", () => {
    recover(ADMIN_USERNAME, "  eyer-call  ", "NewOwner123");

    expect(login(db, ADMIN_USERNAME, "NewOwner123", new Date(NOW)).user.username).toBe(
      ADMIN_USERNAME,
    );
  });

  it("resets a staff account without changing other accounts", () => {
    addStaff("cashier");

    recover("cashier", "EYER-CALL", "Cashier123");

    expect(login(db, "cashier", "Cashier123", new Date(NOW)).user.roleName).toBe("Staff");
    // The administrator signed in with the same password as before.
    expect(login(db, ADMIN_USERNAME, ADMIN_PASSWORD, new Date(NOW)).user.username).toBe(
      ADMIN_USERNAME,
    );
  });

  it("is case-insensitive about the username", () => {
    recover("ADMIN", "UMX", "NewOwner123");

    expect(login(db, ADMIN_USERNAME, "NewOwner123", new Date(NOW)).user.username).toBe(
      ADMIN_USERNAME,
    );
  });
});

describe("what a failed recovery does not do", () => {
  it("uses the same message for an unknown username and a wrong code", () => {
    const messages: string[] = [];

    for (const [username, code] of [
      ["nobody", "UMX"],
      [ADMIN_USERNAME, "not-a-code"],
    ] as const) {
      try {
        recover(username, code, "NewOwner123");
      } catch (error) {
        expect(error).toBeInstanceOf(PasswordRecoveryError);
        messages.push((error as Error).message);
      }
    }

    expect(messages[0]).toBe(messages[1]);
    expect(messages[0]).toMatch(/username or secret code is not valid/i);
    expect(messages[0]).toMatch(/EyerCall/i);

    // A wrong code is not a password change.
    expect(login(db, ADMIN_USERNAME, ADMIN_PASSWORD, new Date(NOW)).user.username).toBe(
      ADMIN_USERNAME,
    );
  });

  it("leaves a deactivated account's password alone", () => {
    db.prepare("UPDATE users SET is_active = 0 WHERE username = ?").run(ADMIN_USERNAME);

    expect(() => recover(ADMIN_USERNAME, "UMX", "NewOwner123")).toThrow(PasswordRecoveryError);

    db.prepare("UPDATE users SET is_active = 1 WHERE username = ?").run(ADMIN_USERNAME);
    expect(login(db, ADMIN_USERNAME, ADMIN_PASSWORD, new Date(NOW)).user.username).toBe(
      ADMIN_USERNAME,
    );
  });

  it("enforces the normal password policy and leaves the code usable", () => {
    expect(() => recover(ADMIN_USERNAME, "UMX", "weak")).toThrow(AuthError);

    expect(login(db, ADMIN_USERNAME, ADMIN_PASSWORD, new Date(NOW)).user.username).toBe(
      ADMIN_USERNAME,
    );

    // The rejected attempt did not consume the code or change the account.
    recover(ADMIN_USERNAME, "UMX", "NewOwner123");
    expect(login(db, ADMIN_USERNAME, "NewOwner123", new Date(NOW)).user.username).toBe(
      ADMIN_USERNAME,
    );
  });

  it("counts wrong codes towards the normal lockout", () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(() => recover(ADMIN_USERNAME, "wrong", "NewOwner123")).toThrow(PasswordRecoveryError);
    }

    const row = db
      .prepare("SELECT failed_attempts, locked_until FROM users WHERE username = ?")
      .get(ADMIN_USERNAME) as { failed_attempts: number; locked_until: string | null };

    expect(row.failed_attempts).toBeGreaterThanOrEqual(5);
    expect(row.locked_until).not.toBeNull();

    // The owner can still recover with the correct code, and recovery clears
    // the lock that the guesses put there.
    recover(ADMIN_USERNAME, "UMX", "NewOwner123");
    expect(login(db, ADMIN_USERNAME, "NewOwner123", new Date(NOW)).user.username).toBe(
      ADMIN_USERNAME,
    );
  });
});

describe("recovering from a locked account", () => {
  it("accepts the correct code even while login is locked, then clears the lock", () => {
    db.prepare("UPDATE users SET failed_attempts = 5, locked_until = ? WHERE username = ?").run(
      "2026-10-27T10:15:00.000Z",
      ADMIN_USERNAME,
    );

    recover(ADMIN_USERNAME, "UMX", "NewOwner123");

    const outcome = login(db, ADMIN_USERNAME, "NewOwner123", new Date(NOW));
    expect(outcome.user.username).toBe(ADMIN_USERNAME);
  });
});
