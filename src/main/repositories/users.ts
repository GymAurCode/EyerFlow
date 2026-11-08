/**
 * Users, roles and login.
 *
 * Two fixed roles, Administrator and Staff, created by `ensureDefaultRoles`
 * with a permission set written in code. There is no role editor: changing what
 * a user can do means changing which of the two roles they hold.
 *
 * Passwords are scrypt hashes (see `domain/auth`). Nothing here is exposed to
 * the renderer except the typed DTOs, so hashes never cross the bridge.
 */

import type { SqliteDatabase } from "../../data/connection";
import {
  DEFAULT_LOCKOUT,
  DEFAULT_PASSWORD_POLICY,
  checkPasswordPolicy,
  evaluateLockout,
  hashPassword,
  lockExpiryIso,
  verifyPassword,
} from "../../domain/auth";
import {
  type PermissionModule,
  STAFF_DENIED_MODULES,
  SYSTEM_ROLES,
} from "../../shared/permissions";
import type {
  ProfileDto,
  RegistrationCreateAccountRequest,
  SaveUserRequest,
  SessionUser,
  SetupRequest,
  UpdateProfileRequest,
  UserDto,
} from "../../shared/types";
import type { AuditActor } from "../audit-writer";
import { recordAudit } from "../audit-writer";
import { isValidAvatarFileName, readAvatarDataUrl } from "../avatars";
import { isSetupCompleteFlag, SETTING_KEYS, writeSetting } from "../settings-store";
import { loadSessionUser } from "../session";

export class AuthError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

/* -------------------------------------------------------------------------- */
/* login                                                                      */
/* -------------------------------------------------------------------------- */

export interface LoginOutcome {
  readonly user: SessionUser;
  readonly message: string | null;
}

/**
 * Authenticate a user.
 *
 * Failure messages are deliberately identical whether the username is unknown
 * or the password is wrong, so the login form cannot be used to discover which
 * usernames exist.
 */
export function login(
  db: SqliteDatabase,
  username: string,
  password: string,
  now: Date,
  avatarsDir?: string,
): LoginOutcome {
  const nowIso = now.toISOString();

  const row = db
    .prepare(
      `SELECT id, username, display_name, password_hash, password_salt, role_id,
              must_change_password, is_active, failed_attempts, locked_until
         FROM users
        WHERE username = ? COLLATE NOCASE`,
    )
    .get(username) as
    | {
        id: number;
        username: string;
        display_name: string;
        password_hash: string;
        password_salt: string;
        role_id: number | null;
        must_change_password: number;
        is_active: number;
        failed_attempts: number;
        locked_until: string | null;
      }
    | undefined;

  if (row === undefined) {
    recordAttempt(db, username, false, nowIso);
    // Still run a hash so a missing user and a wrong password take similar time.
    hashPassword(password, "0".repeat(32));
    throw new AuthError("Wrong username or password.");
  }

  const lock = evaluateLockout(row.failed_attempts, row.locked_until, now);
  if (lock.locked) {
    recordAttempt(db, username, false, nowIso);
    throw new AuthError(lock.message ?? "Account locked.");
  }

  if (row.is_active !== 1) {
    recordAttempt(db, username, false, nowIso);
    throw new AuthError("This account has been deactivated. Ask an administrator to enable it.");
  }

  const ok = verifyPassword(password, { hash: row.password_hash, salt: row.password_salt });

  if (!ok) {
    const attempts = row.failed_attempts + 1;
    const nowLocked = attempts >= DEFAULT_LOCKOUT.threshold;

    db.prepare(
      `UPDATE users
          SET failed_attempts = ?, locked_until = ?, updated_at = ?
        WHERE id = ?`,
    ).run(attempts, nowLocked ? lockExpiryIso(now) : null, nowIso, row.id);

    recordAttempt(db, username, false, nowIso);

    const nextLock = evaluateLockout(attempts, nowLocked ? lockExpiryIso(now) : null, now);

    throw new AuthError(nextLock.message ?? "Wrong username or password.");
  }

  db.prepare(
    "UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = ?, updated_at = ? WHERE id = ?",
  ).run(nowIso, nowIso, row.id);

  recordAttempt(db, username, true, nowIso);

  const user = loadSessionUser(db, row.id, avatarsDir);
  if (user === null) throw new AuthError("This account is no longer available.");

  const message = user.mustChangePassword
    ? "You must change your password before continuing."
    : null;

  return { user, message };
}

function recordAttempt(
  db: SqliteDatabase,
  username: string,
  success: boolean,
  nowIso: string,
): void {
  db.prepare("INSERT INTO login_attempts (username, success, attempted_at) VALUES (?, ?, ?)").run(
    username,
    success ? 1 : 0,
    nowIso,
  );
}

/* -------------------------------------------------------------------------- */
/* registration administration                                                */
/* -------------------------------------------------------------------------- */

/** The account that owns the installation's registration details. */
export interface AdministratorIdentity {
  readonly id: number;
  readonly username: string;
  readonly displayName: string;
  readonly email: string | null;
  readonly phone: string | null;
}

/**
 * The first active administrator, which is the account created by setup.
 *
 * Registration details are installation-level, not per-user, so the login
 * screen needs one stable owner to edit. Ordering by id makes that the setup
 * administrator and keeps the choice stable even after other administrators
 * are added.
 */
export function primaryAdministrator(db: SqliteDatabase): AdministratorIdentity | null {
  const row = db
    .prepare(
      `SELECT u.id, u.username, u.display_name AS displayName, u.email, u.phone
         FROM users u
         JOIN roles r ON r.id = u.role_id
        WHERE r.name = ? AND u.is_active = 1
        ORDER BY u.id
        LIMIT 1`,
    )
    .get(SYSTEM_ROLES.admin) as AdministratorIdentity | undefined;

  return row ?? null;
}

/**
 * Verify an administrator's password without starting a session.
 *
 * Used by the login screen's registration actions, which are privileged but
 * happen before sign-in. It deliberately reuses the same lockout counters as
 * `login`, so these actions cannot become an unlimited password oracle, and it
 * does not update `last_login_at`: proving a password to edit details is not
 * signing in.
 */
export function verifyAdministratorCredentials(
  db: SqliteDatabase,
  username: string,
  password: string,
  now: Date,
): AdministratorIdentity {
  const nowIso = now.toISOString();

  const row = db
    .prepare(
      `SELECT u.id, u.username, u.display_name AS displayName, u.email, u.phone,
              u.password_hash, u.password_salt, u.is_active, u.failed_attempts,
              u.locked_until, r.name AS roleName
         FROM users u
         LEFT JOIN roles r ON r.id = u.role_id
        WHERE u.username = ? COLLATE NOCASE`,
    )
    .get(username) as
    | {
        id: number;
        username: string;
        displayName: string;
        email: string | null;
        phone: string | null;
        password_hash: string;
        password_salt: string;
        is_active: number;
        failed_attempts: number;
        locked_until: string | null;
        roleName: string | null;
      }
    | undefined;

  if (row === undefined) {
    recordAttempt(db, username, false, nowIso);
    // Same work as a real verification, so an unknown name is not faster.
    hashPassword(password, "0".repeat(32));
    throw new AuthError("Wrong username or password.");
  }

  const lock = evaluateLockout(row.failed_attempts, row.locked_until, now);
  if (lock.locked) {
    recordAttempt(db, username, false, nowIso);
    throw new AuthError(lock.message ?? "Account locked.");
  }

  if (row.is_active !== 1) {
    recordAttempt(db, username, false, nowIso);
    throw new AuthError("This account has been deactivated. Ask an administrator to enable it.");
  }

  const ok = verifyPassword(password, { hash: row.password_hash, salt: row.password_salt });

  if (!ok) {
    const attempts = row.failed_attempts + 1;
    const nowLocked = attempts >= DEFAULT_LOCKOUT.threshold;

    db.prepare(
      `UPDATE users
          SET failed_attempts = ?, locked_until = ?, updated_at = ?
        WHERE id = ?`,
    ).run(attempts, nowLocked ? lockExpiryIso(now) : null, nowIso, row.id);

    recordAttempt(db, username, false, nowIso);

    const nextLock = evaluateLockout(attempts, nowLocked ? lockExpiryIso(now) : null, now);
    throw new AuthError(nextLock.message ?? "Wrong username or password.");
  }

  if (row.roleName !== SYSTEM_ROLES.admin) {
    // The password is right, but this is not an administrator. Do not count a
    // lockout failure against a correct password.
    throw new AuthError(
      "Only an administrator can change registration details or create accounts.",
    );
  }

  db.prepare(
    "UPDATE users SET failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?",
  ).run(nowIso, row.id);

  recordAttempt(db, username, true, nowIso);

  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    email: row.email,
    phone: row.phone,
  };
}

/**
 * Create an additional local account for an already-registered installation.
 *
 * This is intentionally just a user row. The active licence already covers the
 * laptop, so no key is issued here; every account signs in through the same
 * machine-bound licence. Existing accounts and all business rows are left
 * untouched.
 */
export function createRegistrationAccount(
  context: { db: SqliteDatabase; actor: AuditActor; nowIso: string },
  request: RegistrationCreateAccountRequest,
): UserDto {
  const { db } = context;

  return db.transaction((): UserDto => {
    const duplicate = db
      .prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE")
      .get(request.username) as { id?: number } | undefined;
    if (duplicate !== undefined) {
      throw new AuthError(`Username ${request.username} is already taken.`);
    }

    const role = db.prepare("SELECT id FROM roles WHERE name = ?").get(request.role) as
      { id: number } | undefined;
    if (role === undefined) {
      throw new AuthError("That account type is not available on this installation.");
    }

    const policy = checkPasswordPolicy(request.password, DEFAULT_PASSWORD_POLICY);
    if (!policy.ok) throw new AuthError(policy.reason);

    const stored = hashPassword(request.password);
    const email = request.email.trim().toLowerCase();
    const phone = request.phone.trim();

    const info = db
      .prepare(
        `INSERT INTO users
           (username, display_name, password_hash, password_salt, role_id,
            must_change_password, is_active, failed_attempts, email, phone,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, 1, 0, ?, ?, ?, ?)`,
      )
      .run(
        request.username,
        request.displayName,
        stored.hash,
        stored.salt,
        role.id,
        email.length > 0 ? email : null,
        phone.length > 0 ? phone : null,
        context.nowIso,
        context.nowIso,
      );

    const id = Number(info.lastInsertRowid);

    recordAudit(
      db,
      context.actor,
      {
        module: "users",
        action: "create",
        entityType: "user",
        entityId: id,
        newValues: {
          username: request.username,
          displayName: request.displayName,
          role: request.role,
          email: email.length > 0 ? email : null,
          phone: phone.length > 0 ? phone : null,
          password: "[redacted]",
        },
      },
      context.nowIso,
    );

    return mapUser(db.prepare(`${USER_SELECT} WHERE u.id = ?`).get(id) as UserRow);
  })();
}

export function changePassword(
  db: SqliteDatabase,
  actor: AuditActor,
  userId: number,
  currentPassword: string,
  newPassword: string,
  nowIso: string,
): void {
  const row = db
    .prepare("SELECT id, password_hash, password_salt FROM users WHERE id = ?")
    .get(userId) as { id: number; password_hash: string; password_salt: string } | undefined;

  if (row === undefined) throw new AuthError("Your account could not be found.");

  if (!verifyPassword(currentPassword, { hash: row.password_hash, salt: row.password_salt })) {
    throw new AuthError("Your current password is not correct.");
  }

  const policy = checkPasswordPolicy(newPassword, DEFAULT_PASSWORD_POLICY);
  if (!policy.ok) throw new AuthError(policy.reason);

  const stored = hashPassword(newPassword);

  db.prepare(
    "UPDATE users SET password_hash = ?, password_salt = ?, must_change_password = 0, updated_at = ? WHERE id = ?",
  ).run(stored.hash, stored.salt, nowIso, userId);

  recordAudit(
    db,
    actor,
    { module: "users", action: "password", entityType: "user", entityId: userId },
    nowIso,
  );
}

/* -------------------------------------------------------------------------- */
/* own profile                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Read one user's profile for the profile page.
 *
 * Every function here takes the id from the session rather than from the
 * request, so there is no call a renderer can make against somebody else's row.
 */
export function readProfile(
  db: SqliteDatabase,
  userId: number,
  avatarsDir: string,
  companyName: string,
): ProfileDto {
  const row = db
    .prepare(
      `SELECT u.id, u.username, u.display_name AS displayName, u.email, u.phone,
              u.avatar_path AS avatarPath, r.name AS roleName,
              u.created_at AS createdAt, u.last_login_at AS lastLoginAt
         FROM users u
         LEFT JOIN roles r ON r.id = u.role_id
        WHERE u.id = ?`,
    )
    .get(userId) as
    | {
        id: number;
        username: string;
        displayName: string;
        email: string | null;
        phone: string | null;
        avatarPath: string | null;
        roleName: string | null;
        createdAt: string | null;
        lastLoginAt: string | null;
      }
    | undefined;

  if (row === undefined) throw new AuthError("Your account could not be found.");

  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    email: row.email,
    phone: row.phone,
    avatarDataUrl: readAvatarDataUrl(avatarsDir, row.avatarPath),
    roleName: row.roleName,
    createdAt: row.createdAt,
    lastLoginAt: row.lastLoginAt,
    companyName,
  };
}

/**
 * Save the signed-in user's own details.
 *
 * The name is trimmed and must not be blank; email and phone are optional and
 * stored as null rather than as an empty string, so "no email" has exactly one
 * representation in the database.
 *
 * `avatarPath` is a file name that has already been vetted by the avatar module.
 * It is not taken on trust here: anything that is not one of our generated
 * names is rejected, so a crafted request cannot aim the row at a file
 * elsewhere on the disk. Omitting the field leaves the stored picture alone;
 * an empty string goes back to the initials avatar.
 *
 * Returns the picture's previous file name so the caller can delete the file it
 * replaces. Deleting a file is not something a repository should be doing, and
 * the main process is the layer that owns the avatars folder.
 */
export function updateOwnProfile(
  context: { db: SqliteDatabase; actor: AuditActor; nowIso: string },
  userId: number,
  request: UpdateProfileRequest,
): { readonly previousAvatar: string | null } {
  const displayName = request.displayName.trim();
  if (displayName.length === 0) {
    throw new AuthError("Enter a name so people can tell who you are.");
  }
  if (displayName.length > 120) {
    throw new AuthError("That name is too long.");
  }

  const email = request.email.trim().toLowerCase();
  const phone = request.phone.trim();

  const before = readProfileColumns(context.db, userId);
  const previousAvatar = currentAvatarName(context.db, userId);

  let avatarColumn: string | null = previousAvatar;
  if (request.avatarPath !== undefined) {
    const wanted = request.avatarPath.trim();
    if (wanted.length > 0 && !isValidAvatarFileName(wanted)) {
      throw new AuthError("That profile picture could not be used. Choose it again.");
    }
    avatarColumn = wanted.length > 0 ? wanted : null;
  }

  context.db
    .prepare(
      `UPDATE users
          SET display_name = ?, email = ?, phone = ?, avatar_path = ?, updated_at = ?
        WHERE id = ?`,
    )
    .run(
      displayName,
      email.length > 0 ? email : null,
      phone.length > 0 ? phone : null,
      avatarColumn,
      context.nowIso,
      userId,
    );

  recordAudit(
    context.db,
    context.actor,
    {
      module: "users",
      action: "updateProfile",
      entityType: "user",
      entityId: userId,
      oldValues: before,
      // The avatar is a file name; the picture itself never enters the log.
      newValues: { displayName, email, phone, avatarPath: avatarColumn },
    },
    context.nowIso,
  );

  return { previousAvatar };
}

/** The stored avatar file name, so a new one can replace the old file. */
export function currentAvatarName(db: SqliteDatabase, userId: number): string | null {
  const row = db.prepare("SELECT avatar_path AS avatarPath FROM users WHERE id = ?").get(userId) as
    { avatarPath: string | null } | undefined;
  return row?.avatarPath ?? null;
}

function readProfileColumns(db: SqliteDatabase, userId: number): Record<string, unknown> | null {
  const row = db
    .prepare("SELECT display_name, email, phone, avatar_path FROM users WHERE id = ?")
    .get(userId) as Record<string, unknown> | undefined;
  return row ?? null;
}

interface UserRow {
  readonly id: number;
  readonly username: string;
  readonly display_name: string;
  readonly role_id: number | null;
  readonly role_name: string | null;
  readonly must_change_password: number;
  readonly is_active: number;
  readonly last_login_at: string | null;
}

function mapUser(row: UserRow): UserDto {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    roleId: row.role_id,
    roleName: row.role_name,
    mustChangePassword: row.must_change_password === 1,
    isActive: row.is_active === 1,
    lastLoginAt: row.last_login_at,
  };
}

const USER_SELECT = `
  SELECT u.id, u.username, u.display_name, u.role_id, r.name AS role_name,
         u.must_change_password, u.is_active, u.last_login_at
    FROM users u
    LEFT JOIN roles r ON r.id = u.role_id
`;

export function listUsers(db: SqliteDatabase): UserDto[] {
  const rows = db.prepare(`${USER_SELECT} ORDER BY u.display_name`).all() as UserRow[];
  return rows.map(mapUser);
}

export function saveUser(
  context: { db: SqliteDatabase; actor: AuditActor; nowIso: string },
  request: SaveUserRequest,
): UserDto {
  const { db } = context;

  return db.transaction((): UserDto => {
    assertValidRole(db, request.roleId);

    if (request.id !== undefined) {
      const before = db.prepare("SELECT * FROM users WHERE id = ?").get(request.id) as
        Record<string, unknown> | undefined;
      if (before === undefined) throw new AuthError(`User ${String(request.id)} was not found.`);

      const duplicate = db
        .prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE AND id <> ?")
        .get(request.username, request.id) as { id?: number } | undefined;
      if (duplicate !== undefined)
        throw new AuthError(`Username ${request.username} is already taken.`);

      db.prepare(
        `UPDATE users
            SET username = ?, display_name = ?, role_id = ?, is_active = ?,
                must_change_password = COALESCE(?, must_change_password), updated_at = ?
          WHERE id = ?`,
      ).run(
        request.username,
        request.displayName,
        request.roleId ?? null,
        request.isActive ? 1 : 0,
        request.mustChangePassword === undefined ? null : request.mustChangePassword ? 1 : 0,
        context.nowIso,
        request.id,
      );

      if (request.password !== undefined && request.password !== null) {
        setPassword(db, request.id, request.password, context.nowIso);
      }

      recordAudit(
        db,
        context.actor,
        {
          module: "users",
          action: "update",
          entityType: "user",
          entityId: request.id,
          oldValues: before,
          newValues: {
            ...request,
            password: request.password === undefined ? undefined : "[redacted]",
          },
        },
        context.nowIso,
      );

      return mapUser(db.prepare(`${USER_SELECT} WHERE u.id = ?`).get(request.id) as UserRow);
    }

    const duplicate = db
      .prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE")
      .get(request.username) as { id?: number } | undefined;
    if (duplicate !== undefined) {
      throw new AuthError(`Username ${request.username} is already taken.`);
    }

    const policy = checkPasswordPolicy(request.password ?? "", DEFAULT_PASSWORD_POLICY);
    if (!policy.ok) throw new AuthError(policy.reason);

    const stored = hashPassword(request.password ?? "");

    const info = db
      .prepare(
        `INSERT INTO users
           (username, display_name, password_hash, password_salt, role_id, must_change_password,
            is_active, failed_attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(
        request.username,
        request.displayName,
        stored.hash,
        stored.salt,
        request.roleId ?? null,
        request.mustChangePassword === false ? 0 : 1,
        request.isActive ? 1 : 0,
        context.nowIso,
        context.nowIso,
      );

    const id = Number(info.lastInsertRowid);

    recordAudit(
      db,
      context.actor,
      {
        module: "users",
        action: "create",
        entityType: "user",
        entityId: id,
        newValues: { ...request, password: "[redacted]" },
      },
      context.nowIso,
    );

    return mapUser(db.prepare(`${USER_SELECT} WHERE u.id = ?`).get(id) as UserRow);
  })();
}

/** Only the two fixed roles may ever be assigned. */
function assertValidRole(db: SqliteDatabase, roleId: number | null): void {
  if (roleId === null) {
    throw new AuthError("Every user needs a role: Administrator or Staff.");
  }

  const row = db.prepare("SELECT name FROM roles WHERE id = ?").get(roleId) as
    { name: string } | undefined;

  if (row === undefined) {
    throw new AuthError("That role no longer exists. Pick Administrator or Staff.");
  }
  if (row.name !== SYSTEM_ROLES.admin && row.name !== SYSTEM_ROLES.staff) {
    throw new AuthError("Only the Administrator and Staff roles can be assigned.");
  }
}

export function resetPassword(
  context: { db: SqliteDatabase; actor: AuditActor; nowIso: string },
  id: number,
  newPassword: string,
  mustChangePassword: boolean,
  /** Audit action; secret-code recovery records its own reason. */
  action = "resetPassword",
): UserDto {
  const { db } = context;

  const policy = checkPasswordPolicy(newPassword, DEFAULT_PASSWORD_POLICY);
  if (!policy.ok) throw new AuthError(policy.reason);

  const target = db.prepare("SELECT id FROM users WHERE id = ?").get(id) as
    { id: number } | undefined;
  if (target === undefined) throw new AuthError(`User ${String(id)} was not found.`);

  setPassword(db, id, newPassword, context.nowIso);

  db.prepare("UPDATE users SET must_change_password = ?, updated_at = ? WHERE id = ?").run(
    mustChangePassword ? 1 : 0,
    context.nowIso,
    id,
  );

  recordAudit(
    db,
    context.actor,
    { module: "users", action, entityType: "user", entityId: id },
    context.nowIso,
  );

  return mapUser(db.prepare(`${USER_SELECT} WHERE u.id = ?`).get(id) as UserRow);
}

function setPassword(db: SqliteDatabase, userId: number, password: string, nowIso: string): void {
  const policy = checkPasswordPolicy(password, DEFAULT_PASSWORD_POLICY);
  if (!policy.ok) throw new AuthError(policy.reason);

  const stored = hashPassword(password);
  db.prepare(
    "UPDATE users SET password_hash = ?, password_salt = ?, failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?",
  ).run(stored.hash, stored.salt, nowIso, userId);
}

/* -------------------------------------------------------------------------- */
/* first-run setup                                                            */
/* -------------------------------------------------------------------------- */

export function isSetupComplete(db: SqliteDatabase): boolean {
  return isSetupCompleteFlag(db);
}

/**
 * First-run setup: company details and the first administrator.
 *
 * Writes the settings and the admin in one transaction so a failure leaves the
 * database still unconfigured rather than half-configured, which would leave
 * the shop unable to log in.
 */
export function runSetup(
  context: { db: SqliteDatabase; actor: AuditActor; nowIso: string },
  request: SetupRequest,
): void {
  const { db } = context;

  db.transaction(() => {
    if (isSetupComplete(db)) {
      throw new AuthError(
        "Setup has already been completed. Change settings from the Settings screen.",
      );
    }

    const policy = checkPasswordPolicy(request.adminPassword, DEFAULT_PASSWORD_POLICY);
    if (!policy.ok) throw new AuthError(policy.reason);

    const adminRoleId = ensureDefaultRoles(db, context.nowIso);
    const stored = hashPassword(request.adminPassword);

    db.prepare(
      `INSERT INTO users
         (username, display_name, password_hash, password_salt, role_id, must_change_password,
          is_active, failed_attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, 1, 0, ?, ?)`,
    ).run(
      request.adminUsername,
      request.adminDisplayName,
      stored.hash,
      stored.salt,
      adminRoleId,
      context.nowIso,
      context.nowIso,
    );

    writeSetting(db, SETTING_KEYS.companyName, request.companyName);
    writeSetting(db, SETTING_KEYS.companyTrn, request.companyTrn);
    writeSetting(db, SETTING_KEYS.companyAddress, request.companyAddress);
    writeSetting(db, SETTING_KEYS.companyPhone, request.companyPhone);
    writeSetting(db, SETTING_KEYS.fiscalYearStartMonth, String(request.fiscalYearStartMonth));
    writeSetting(db, SETTING_KEYS.theme, "light");
    writeSetting(db, SETTING_KEYS.setupComplete, "1");

    recordAudit(
      db,
      context.actor,
      {
        module: "settings",
        action: "setup",
        entityType: "app",
        entityId: null,
        newValues: { companyName: request.companyName, admin: request.adminUsername },
      },
      context.nowIso,
    );
  })();
}

/**
 * Create the two fixed roles, returning the Administrator's id.
 *
 * Idempotent by name: an existing Administrator keeps its id, so the users
 * already pointing at it are untouched.
 */
export function ensureDefaultRoles(db: SqliteDatabase, nowIso: string): number {
  const insertRole = db.prepare(
    "INSERT OR IGNORE INTO roles (name, description, is_system, created_at) VALUES (?, ?, 1, ?)",
  );

  insertRole.run(
    SYSTEM_ROLES.admin,
    "Full access, including settings and user management.",
    nowIso,
  );
  insertRole.run(
    SYSTEM_ROLES.staff,
    "Day-to-day selling and stock. No profit reports, no settings.",
    nowIso,
  );

  const rows = db.prepare("SELECT id, name FROM roles").all() as { id: number; name: string }[];
  const byName = new Map(rows.map((row) => [row.name, row.id]));

  const adminId = byName.get(SYSTEM_ROLES.admin);
  const staffId = byName.get(SYSTEM_ROLES.staff);
  if (adminId === undefined || staffId === undefined) {
    throw new AuthError("The fixed roles could not be created.");
  }

  // The permission matrix is fixed in code, so a tampered database cannot hand
  // a Staff account more than it should have.
  db.prepare("DELETE FROM role_permissions").run();
  const insertPermission = db.prepare(
    "INSERT OR IGNORE INTO role_permissions (role_id, module, action) VALUES (?, ?, ?)",
  );

  const allActions = ["view", "create", "edit", "delete", "cancel", "export"] as const;
  const staffActions = ["view", "create", "edit", "delete", "cancel"] as const;

  for (const module of [
    "dashboard",
    "parties",
    "products",
    "sales",
    "purchases",
    "inventory",
    "manufacturing",
      "warehouse",
    "payments",
    "finance",
    "reports",
    "partners",
    "users",
    "settings",
    "backup",
  ] satisfies readonly PermissionModule[]) {
    for (const action of allActions) {
      insertPermission.run(adminId, module, action);
    }
  }

  for (const module of [
    "dashboard",
    "parties",
    "products",
    "sales",
    "purchases",
    "inventory",
    "manufacturing",
    "payments",
    "finance",
    "backup",
  ] satisfies readonly PermissionModule[]) {
    if (STAFF_DENIED_MODULES.includes(module)) continue;
    for (const action of staffActions) {
      insertPermission.run(staffId, module, action);
    }
  }

  return adminId;
}

/** The role ids the users screen offers, in display order. */
export function roleOptions(db: SqliteDatabase): readonly { id: number; name: string }[] {
  const rows = db
    .prepare("SELECT id, name FROM roles WHERE name IN (?, ?) ORDER BY name")
    .all(SYSTEM_ROLES.admin, SYSTEM_ROLES.staff) as { id: number; name: string }[];
  return rows;
}
