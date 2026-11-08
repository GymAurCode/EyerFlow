/**
 * Permission model.
 *
 * Two fixed roles, Administrator and Staff. There is no role editor: the
 * permission matrix is set by migration 18 and by `ensureDefaultRoles`, and the
 * only way to change a user's access is to change which of the two roles they
 * hold. That is deliberate - a small shop does not need bespoke roles, and a
 * fixed matrix is one that can be reasoned about.
 *
 * Modules map to the sidebar entries; `partners` is not a page but is granted
 * with `reports` so the Tax & Partners settings tab can be edited.
 */

export const PERMISSION_ACTIONS = [
  "view",
  "create",
  "edit",
  "delete",
  "cancel",
  "export",
] as const;

export type PermissionAction = (typeof PERMISSION_ACTIONS)[number];

export const PERMISSION_MODULES = [
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
] as const;

export type PermissionModule = (typeof PERMISSION_MODULES)[number];

export interface Permission {
  readonly module: PermissionModule;
  readonly action: PermissionAction;
}

export function permissionKey(module: PermissionModule, action: PermissionAction): string {
  return `${module}:${action}`;
}

export function isPermissionModule(value: string): value is PermissionModule {
  return (PERMISSION_MODULES as readonly string[]).includes(value);
}

export function isPermissionAction(value: string): value is PermissionAction {
  return (PERMISSION_ACTIONS as readonly string[]).includes(value);
}

/** Modules Staff does not hold: profit-bearing reports, the split, settings. */
export const STAFF_DENIED_MODULES: readonly PermissionModule[] = ["reports", "partners", "settings"];

/** Modules Administrator holds that Staff does not, for the users screen. */
export const ADMIN_ONLY_MODULES: readonly PermissionModule[] = ["users", ...STAFF_DENIED_MODULES];

/** The two fixed roles, in display order. */
export const SYSTEM_ROLES = {
  admin: "Administrator",
  staff: "Staff",
} as const;

export type SystemRoleKey = keyof typeof SYSTEM_ROLES;
