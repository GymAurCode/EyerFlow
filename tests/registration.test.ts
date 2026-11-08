/**
 * Registration management tests.
 *
 * These exercise the real RPC handlers, repositories and settings service
 * against an in-memory database. Only the two edges that need a machine are
 * mocked: Electron and the licence/hardware reader. That keeps the tests
 * offline and makes "a key copied from another laptop" a state we can create
 * deterministically.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import type { SqliteDatabase } from "../src/data/connection";
import type { RpcDeps } from "../src/main/rpc";
import type {
  RegistrationDetails,
  RegistrationStatus,
  SetupRequest,
  UserDto,
} from "../src/shared/types";
import { SYSTEM_ACTOR } from "../src/main/audit-writer";
import { SessionStore } from "../src/main/session";
import { SettingsService } from "../src/main/settings";
import type { Logger } from "../src/main/logger";
import { freshDb, migrateInMemory, createTempWorkspace, type TempWorkspace } from "./helpers";

const NOW = new Date("2026-10-27T10:00:00.000Z");

const harness = vi.hoisted(() => ({
  licenseDisabled: false,
  licenseValid: true,
  licenseError: null as string | null,
  machineId: "machine-a",
  payload: {
    machineId: "machine-a",
    clientName: "Acme Water",
    issuedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2027-01-01T00:00:00.000Z",
    edition: "Standard",
  },
  saveLicenseCalls: 0,
}));

vi.mock("electron", () => ({
  app: {
    getPath: () => "C:\\temp\\eyerstock-registration-test",
    isPackaged: false,
  },
  BrowserWindow: class {},
  dialog: {
    showSaveDialog: () => Promise.resolve({ canceled: true, filePath: undefined }),
  },
}));

vi.mock("../src/main/machine-id", () => ({
  getMachineId: () => Promise.resolve(harness.machineId),
  warmMachineId: () => undefined,
  resetMachineIdCache: () => undefined,
}));

vi.mock("../src/main/license", () => ({
  isLicenseDisabled: () => harness.licenseDisabled,
  loadAndVerifyLicense: () =>
    Promise.resolve({
      valid: harness.licenseValid,
      payload: harness.licenseValid ? harness.payload : null,
      error: harness.licenseError,
      daysUntilExpiry: null,
      isExpiringSoon: false,
    }),
  getLicenseStatus: () => Promise.resolve(null),
  saveLicense: () => {
    harness.saveLicenseCalls += 1;
  },
  verifyLicenseKey: () =>
    Promise.resolve({
      valid: harness.licenseValid,
      payload: harness.licenseValid ? harness.payload : null,
      error: harness.licenseError,
      daysUntilExpiry: null,
      isExpiringSoon: false,
    }),
}));

import { createRpcMethods } from "../src/main/rpc";
import {
  login,
  primaryAdministrator,
  runSetup,
  verifyAdministratorCredentials,
} from "../src/main/repositories/users";
import { getRegistrationStatus } from "../src/main/registration";
import { verifyPassword } from "../src/domain/auth";

const SETUP: SetupRequest = {
  companyName: "Blue Water",
  companyTrn: "TRN-001",
  companyAddress: "12 Canal Road",
  companyPhone: "+92 300 0000000",
  fiscalYearStartMonth: 1,
  adminUsername: "admin",
  adminDisplayName: "Owner Name",
  adminPassword: "OwnerPass1",
};

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

interface Fixture {
  readonly db: SqliteDatabase;
  readonly deps: RpcDeps;
  readonly methods: ReturnType<typeof createRpcMethods>;
}

let workspace: TempWorkspace | undefined;
let fixture: Fixture | undefined;

function makeFixture(): Fixture {
  const db = freshDb();
  migrateInMemory(db);
  runSetup({ db, actor: SYSTEM_ACTOR, nowIso: NOW.toISOString() }, SETUP);

  const settings = new SettingsService(db, join(workspace?.dir ?? ".", "settings.json"), logger);
  settings.refresh();

  // Business data that a registration edit must never touch.
  db.prepare(
    `INSERT INTO parties (code, name, kind, opening_balance, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("C-0001", "Existing Customer", "customer", 12_500, NOW.toISOString(), NOW.toISOString());

  const session = new SessionStore(db);
  const deps: RpcDeps = {
    db,
    session,
    now: () => NOW,
    loadSettings: () => settings.load(),
    updateSettings: (patch) => settings.update(patch),
    refreshSettings: () => settings.refresh(),
    exportDir: () => workspace?.dir ?? ".",
    avatarsDir: () => workspace?.dir ?? ".",
    token: "test-token",
    saveDevSession: () => undefined,
    loadDevSession: () => null,
    canRestoreDevSession: () => false,
    clearDevSession: () => undefined,
  };

  return { db, deps, methods: createRpcMethods() };
}

async function invoke(
  name: string,
  payload: unknown,
  target: Fixture = fixture as Fixture,
): Promise<unknown> {
  const definition = target.methods[name];
  if (definition === undefined) throw new Error(`No RPC method named ${name}`);
  const validated = definition.schema.parse(payload);
  return await definition.handler(validated, target.deps, {
    db: target.db,
    actor: SYSTEM_ACTOR,
    fiscalYearStartMonth: 1,
    nowIso: NOW.toISOString(),
    nowDate: "2026-10-27",
    fiscalYearOf: () => 2026,
    allowNegativeStock: false,
    vatRate: 5,
  });
}

function authorisation(): { username: string; password: string } {
  return { username: SETUP.adminUsername, password: SETUP.adminPassword };
}

function accountAuthorisation(): { authorizedUsername: string; authorizedPassword: string } {
  return {
    authorizedUsername: SETUP.adminUsername,
    authorizedPassword: SETUP.adminPassword,
  };
}

beforeEach(() => {
  harness.licenseDisabled = false;
  harness.licenseValid = true;
  harness.licenseError = null;
  harness.machineId = "machine-a";
  harness.payload = {
    machineId: "machine-a",
    clientName: "Acme Water",
    issuedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2027-01-01T00:00:00.000Z",
    edition: "Standard",
  };
  harness.saveLicenseCalls = 0;

  workspace = createTempWorkspace("eyerstock-registration-");
  fixture = makeFixture();
});

afterEach(() => {
  fixture?.db.close();
  fixture = undefined;
  workspace?.cleanup();
  workspace = undefined;
});

describe("registration status", () => {
  it("reports the setup administrator without exposing licence or machine secrets", () => {
    const status = getRegistrationStatus((fixture as Fixture).db);

    expect(status).toEqual<RegistrationStatus>({
      setupComplete: true,
      administratorUsername: SETUP.adminUsername,
      administratorName: SETUP.adminDisplayName,
    });
    expect(JSON.stringify(status)).not.toMatch(/machine|licen[cs]e|password/i);
  });

  it("reports no administrator before setup is complete", () => {
    const db = freshDb();
    migrateInMemory(db);
    try {
      expect(getRegistrationStatus(db)).toEqual<RegistrationStatus>({
        setupComplete: false,
        administratorUsername: null,
        administratorName: null,
      });
    } finally {
      db.close();
    }
  });
});

describe("reading registration details", () => {
  it("prefills the existing business, owner and signed licence details", async () => {
    const details = (await invoke("registration.details", authorisation())) as RegistrationDetails;

    expect(details).toMatchObject({
      username: SETUP.adminUsername,
      companyName: SETUP.companyName,
      companyTrn: SETUP.companyTrn,
      companyAddress: SETUP.companyAddress,
      companyPhone: SETUP.companyPhone,
      companyEmail: "",
      ownerName: SETUP.adminDisplayName,
      ownerEmail: "",
      ownerPhone: "",
      licensedClientName: "Acme Water",
      edition: "Standard",
      expiresAt: "2027-01-01T00:00:00.000Z",
    });
    // The password proves the caller may read these details; it is not part of
    // the registration that gets returned.
    expect("password" in details).toBe(false);
  });

  it("refuses details for a licence copied from another computer", async () => {
    harness.payload = { ...harness.payload, machineId: "machine-b" };

    await expect(invoke("registration.details", authorisation())).rejects.toMatchObject({
      name: "RegistrationError",
      message: expect.stringMatching(/different computer/i),
    });
  });

  it("refuses details when the stored licence is invalid or expired", async () => {
    harness.licenseValid = false;
    harness.licenseError = "License expired";

    await expect(invoke("registration.details", authorisation())).rejects.toMatchObject({
      name: "RegistrationError",
      message: "License expired",
    });
  });

  it("uses the normal lockout policy for the password check", async () => {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await expect(
        invoke("registration.details", {
          username: SETUP.adminUsername,
          password: `WrongPass${String(attempt)}`,
        }),
      ).rejects.toMatchObject({ name: "AuthError" });
    }

    await expect(invoke("registration.details", authorisation())).rejects.toMatchObject({
      name: "AuthError",
      message: expect.stringMatching(/too many wrong attempts/i),
    });
  });
});

describe("editing registration details", () => {
  it("updates the existing settings and administrator row without touching business data", async () => {
    const before = primaryAdministrator((fixture as Fixture).db);
    expect(before).not.toBeNull();
    const storedBefore = (fixture as Fixture).db
      .prepare("SELECT password_hash, password_salt FROM users WHERE id = ?")
      .get(before?.id) as { password_hash: string; password_salt: string };

    const updated = (await invoke("registration.update", {
      ...authorisation(),
      companyName: "Blue Water Services",
      companyTrn: "TRN-002",
      companyAddress: "14 Canal Road",
      companyPhone: "+92 301 1111111",
      companyEmail: "office@bluewater.test",
      ownerName: "New Owner",
      ownerEmail: "OWNER@BLUEWATER.TEST",
      ownerPhone: "+92 302 2222222",
    })) as RegistrationDetails;

    expect(updated).toMatchObject({
      companyName: "Blue Water Services",
      companyTrn: "TRN-002",
      companyAddress: "14 Canal Road",
      companyPhone: "+92 301 1111111",
      companyEmail: "office@bluewater.test",
      ownerName: "New Owner",
      ownerEmail: "owner@bluewater.test",
      ownerPhone: "+92 302 2222222",
      licensedClientName: "Acme Water",
      edition: "Standard",
    });
    expect("password" in updated).toBe(false);

    const db = (fixture as Fixture).db;
    expect(db.prepare("SELECT COUNT(*) AS count FROM users").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM parties").get()).toEqual({ count: 1 });

    const ownerRow = db
      .prepare(
        `SELECT id, username, display_name AS displayName, email, phone,
                role_id AS roleId, password_hash AS passwordHash,
                password_salt AS passwordSalt
           FROM users
          WHERE id = ?`,
      )
      .get(before?.id) as {
      id: number;
      username: string;
      displayName: string;
      email: string | null;
      phone: string | null;
      roleId: number;
      passwordHash: string;
      passwordSalt: string;
    };

    expect(ownerRow).toMatchObject({
      id: before?.id,
      username: SETUP.adminUsername,
      displayName: "New Owner",
      email: "owner@bluewater.test",
      phone: "+92 302 2222222",
    });
    // The owner's password and role are not part of registration editing.
    expect(ownerRow.passwordHash).toBe(storedBefore.password_hash);
    expect(ownerRow.passwordSalt).toBe(storedBefore.password_salt);
    expect(
      verifyPassword(SETUP.adminPassword, {
        hash: ownerRow.passwordHash,
        salt: ownerRow.passwordSalt,
      }),
    ).toBe(true);

    const party = db
      .prepare("SELECT code, name, opening_balance AS openingBalance FROM parties")
      .get() as { code: string; name: string; openingBalance: number };
    expect(party).toEqual({
      code: "C-0001",
      name: "Existing Customer",
      openingBalance: 12_500,
    });
  });

  it("rejects an invalid email before writing either the settings or the owner row", async () => {
    await expect(
      invoke("registration.update", {
        ...authorisation(),
        companyName: "Changed Name",
        companyTrn: "",
        companyAddress: "",
        companyPhone: "",
        companyEmail: "office@bluewater.test",
        ownerName: "Changed Owner",
        ownerEmail: "not-an-email",
        ownerPhone: "",
      }),
    ).rejects.toMatchObject({ name: "ZodError" });

    expect((fixture as Fixture).deps.loadSettings().companyName).toBe(SETUP.companyName);
    expect(primaryAdministrator((fixture as Fixture).db)?.displayName).toBe(SETUP.adminDisplayName);
  });
});

describe("creating another account", () => {
  it("adds one local account to the shared database and leaves the existing account intact", async () => {
    const db = (fixture as Fixture).db;
    const ownerBefore = primaryAdministrator(db);

    const created = (await invoke("registration.createAccount", {
      ...accountAuthorisation(),
      username: "cashier",
      displayName: "Front Desk",
      email: "cashier@bluewater.test",
      phone: "+92 333 4444444",
      password: "Cashier123",
      role: "Staff",
    })) as UserDto;

    expect(created).toMatchObject({
      username: "cashier",
      displayName: "Front Desk",
      roleName: "Staff",
      mustChangePassword: false,
      isActive: true,
    });
    expect(harness.saveLicenseCalls).toBe(0);

    expect(db.prepare("SELECT COUNT(*) AS count FROM users").get()).toEqual({ count: 2 });
    expect(primaryAdministrator(db)).toEqual(ownerBefore);
    expect(db.prepare("SELECT COUNT(*) AS count FROM parties").get()).toEqual({ count: 1 });

    // Both accounts sign in to the same installation and therefore the same
    // business rows.
    expect(login(db, "cashier", "Cashier123", NOW).user.roleName).toBe("Staff");
    expect(login(db, SETUP.adminUsername, SETUP.adminPassword, NOW).user.username).toBe(
      SETUP.adminUsername,
    );
    expect(db.prepare("SELECT COUNT(*) AS count FROM parties").get()).toEqual({ count: 1 });
  });

  it("rejects a duplicate username without changing either account", async () => {
    await expect(
      invoke("registration.createAccount", {
        ...accountAuthorisation(),
        username: SETUP.adminUsername,
        displayName: "Duplicate",
        email: "",
        phone: "",
        password: "Duplicate123",
        role: "Staff",
      }),
    ).rejects.toMatchObject({
      name: "AuthError",
      message: expect.stringMatching(/already taken/i),
    });

    expect((fixture as Fixture).db.prepare("SELECT COUNT(*) AS count FROM users").get()).toEqual({
      count: 1,
    });
  });

  it("does not create an account when the authorising password is wrong", async () => {
    await expect(
      invoke("registration.createAccount", {
        ...accountAuthorisation(),
        authorizedPassword: "NotThePassword1",
        username: "cashier",
        displayName: "Front Desk",
        email: "",
        phone: "",
        password: "Cashier123",
        role: "Staff",
      }),
    ).rejects.toMatchObject({ name: "AuthError" });

    expect((fixture as Fixture).db.prepare("SELECT COUNT(*) AS count FROM users").get()).toEqual({
      count: 1,
    });
  });

  it("refuses account creation under a licence copied from another computer", async () => {
    harness.payload = { ...harness.payload, machineId: "machine-b" };

    await expect(
      invoke("registration.createAccount", {
        ...accountAuthorisation(),
        username: "cashier",
        displayName: "Front Desk",
        email: "",
        phone: "",
        password: "Cashier123",
        role: "Staff",
      }),
    ).rejects.toMatchObject({
      name: "RegistrationError",
      message: expect.stringMatching(/different computer/i),
    });

    expect((fixture as Fixture).db.prepare("SELECT COUNT(*) AS count FROM users").get()).toEqual({
      count: 1,
    });
  });
});

describe("registration credentials", () => {
  it("does not sign the administrator in as a side effect of checking their password", () => {
    verifyAdministratorCredentials((fixture as Fixture).db, "admin", "OwnerPass1", NOW);

    expect((fixture as Fixture).deps.session.currentOrNull()).toBeNull();
    const row = (fixture as Fixture).db
      .prepare("SELECT last_login_at AS lastLoginAt FROM users WHERE username = ?")
      .get("admin") as { lastLoginAt: string | null };
    expect(row.lastLoginAt).toBeNull();
  });
});
