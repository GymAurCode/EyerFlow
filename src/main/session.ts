/**
 * Session and permission enforcement for the RPC layer.
 *
 * The session lives in the main process, not the renderer. The renderer only
 * holds a copy of the user for display; every request is re-checked here, so a
 * tampered renderer cannot widen its own access.
 */

import type { SqliteDatabase } from "../data/connection";
import {
  type PermissionAction,
  type PermissionModule,
  isPermissionAction,
  isPermissionModule,
} from "../shared/permissions";
import type { SessionUser } from "../shared/types";
import { readAvatarDataUrl } from "./avatars";

export interface Session {
  readonly user: SessionUser;
}

export class PermissionError extends Error {
  public constructor(module: string, action: string) {
    super(`Your role does not allow "${action}" in "${module}". Ask an administrator for access.`);
    this.name = "PermissionError";
  }
}

export class NotAuthenticatedError extends Error {
  public constructor() {
    super("Please sign in again. Your session has ended.");
    this.name = "NotAuthenticatedError";
  }
}

export class SessionStore {
  private session: Session | null = null;

  public constructor(
    private readonly db: SqliteDatabase,
    /** Where profile pictures live, so a session read can inline one. */
    private readonly avatarsDir?: string,
  ) {}

  public current(): Session {
    if (this.session === null) throw new NotAuthenticatedError();
    return this.session;
  }

  public currentOrNull(): Session | null {
    return this.session;
  }

  public set(session: Session | null): void {
    this.session = session;
  }

  /** Throws unless the signed-in user holds `module:action`. */
  public require(module: PermissionModule, action: PermissionAction): SessionUser {
    const user = this.current().user;
    const allowed = user.permissions.some(
      (permission) => permission.module === module && permission.action === action,
    );

    if (!allowed) throw new PermissionError(module, action);

    return user;
  }

  public isAllowed(module: PermissionModule, action: PermissionAction): boolean {
    const session = this.session;
    if (session === null) return false;
    return session.user.permissions.some(
      (permission) => permission.module === module && permission.action === action,
    );
  }

  /**
   * Require an action, or return null when the session is absent.
   *
   * Used by read-only handlers so a signed-out renderer gets an empty list
   * rather than an error popup on every screen at once.
   */
  public optionalRequire(module: PermissionModule, action: PermissionAction): SessionUser | null {
    if (this.session === null) return null;
    return this.require(module, action);
  }

  public reloadPermissions(userId: number): void {
    if (this.session === null) return;
    const user = loadSessionUser(this.db, userId, this.avatarsDir);
    if (user === null) {
      this.session = null;
      return;
    }
    this.session = { user };
  }
}

/**
 * Read the signed-in user's record, with permissions and picture resolved.
 *
 * `avatarsDir` is a parameter rather than a call into `electron` so this module
 * stays free of the main-process API and can be exercised directly against a
 * temporary database. Pass nothing and the user simply gets no picture.
 */
export function loadSessionUser(
  db: SqliteDatabase,
  userId: number,
  avatarsDir?: string,
): SessionUser | null {
  const row = db
    .prepare(
      `SELECT u.id, u.username, u.display_name AS displayName, u.role_id AS roleId,
              u.must_change_password AS mustChangePassword, r.name AS roleName,
              u.email, u.phone, u.avatar_path AS avatarPath,
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
        roleId: number | null;
        mustChangePassword: number;
        roleName: string | null;
        email: string | null;
        phone: string | null;
        avatarPath: string | null;
        createdAt: string | null;
        lastLoginAt: string | null;
      }
    | undefined;

  if (row === undefined) return null;

  const permissions = loadPermissions(db, row.roleId);

  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    roleId: row.roleId,
    roleName: row.roleName,
    mustChangePassword: row.mustChangePassword === 1,
    email: row.email,
    phone: row.phone,
    avatarDataUrl:
      avatarsDir === undefined ? null : readAvatarDataUrl(avatarsDir, row.avatarPath),
    createdAt: row.createdAt,
    lastLoginAt: row.lastLoginAt,
    permissions,
  };
}

export function loadPermissions(
  db: SqliteDatabase,
  roleId: number | null,
): readonly { readonly module: string; readonly action: string }[] {
  if (roleId === null) return [];

  const rows = db
    .prepare("SELECT module, action FROM role_permissions WHERE role_id = ? ORDER BY module, action")
    .all(roleId) as { module: string; action: string }[];

  // Unknown rows (a module removed in a later version) are dropped rather than
  // passed to the renderer, so the UI cannot render a dead menu entry.
  return rows.filter(
    (row) => isPermissionModule(row.module) && isPermissionAction(row.action),
  );
}

export function hasPermission(
  permissions: readonly { readonly module: string; readonly action: string }[],
  module: string,
  action: string,
): boolean {
  return permissions.some(
    (permission) => permission.module === module && permission.action === action,
  );
}