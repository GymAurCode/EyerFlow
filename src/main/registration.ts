/**
 * Registration management for the login screen.
 *
 * The application already has one offline licence per installation, bound to a
 * hardware fingerprint, and one shared business database for every local user.
 * These helpers extend that architecture rather than replacing it:
 *
 *   - a registration edit writes the existing `settings` rows and the existing
 *     administrator row; it never writes a second registration record;
 *   - a new account is one more `users` row under the same licence and the same
 *     database;
 *   - every privileged action re-checks the stored Ed25519 licence and the
 *     machine it was issued for. Nothing here forges, re-signs or re-activates
 *     a key.
 *
 * No function in this module returns the machine id or the licence key. The
 * renderer only ever sees the licence's customer name, edition and expiry,
 * which the app already shows elsewhere.
 */

import type { SqliteDatabase } from "../data/connection";
import type { AppSettingsSnapshot } from "../shared/ipc";
import type { RegistrationDetails, RegistrationStatus } from "../shared/types";
import type { LicensePayload } from "./license-verify";
import { isLicenseDisabled, loadAndVerifyLicense } from "./license";
import { getMachineId } from "./machine-id";
import {
  isSetupComplete,
  primaryAdministrator,
  type AdministratorIdentity,
} from "./repositories/users";

/** A shop-facing failure in a registration action. */
export class RegistrationError extends Error {
  public readonly field: string | undefined;

  public constructor(message: string, field?: string) {
    super(message);
    this.name = "RegistrationError";
    this.field = field;
  }
}

/**
 * What the login screen needs to decide whether the options make sense.
 *
 * Contains no contact details, machine id or licence key. The login screen is
 * anonymous, so this is only the minimum needed to show or hide the buttons.
 */
export function getRegistrationStatus(db: SqliteDatabase): RegistrationStatus {
  const setupComplete = isSetupComplete(db);
  const administrator = setupComplete ? primaryAdministrator(db) : null;

  return {
    setupComplete,
    administratorUsername: administrator?.username ?? null,
    administratorName: administrator?.displayName ?? null,
  };
}

/**
 * Require a valid licence that is bound to this exact computer.
 *
 * `loadAndVerifyLicense` already checks the signature, expiry, clock rollback
 * and payload machine id. The explicit comparison below is belt and braces:
 * it makes the same-laptop rule visible at the registration boundary and keeps
 * it true if the licence verifier is refactored.
 *
 * Null means licensing is disabled in a development run, exactly as the rest
 * of the app treats `LICENCE_DISABLED=1`.
 */
export async function requireLicensedDevice(): Promise<LicensePayload | null> {
  if (isLicenseDisabled()) return null;

  let result: Awaited<ReturnType<typeof loadAndVerifyLicense>>;
  try {
    result = await loadAndVerifyLicense();
  } catch {
    throw new RegistrationError(
      "The licence on this computer could not be checked. Restart EyerStock and try again.",
    );
  }

  if (!result.valid || result.payload === null) {
    throw new RegistrationError(
      result.error ?? "A valid EyerStock licence is required on this computer.",
    );
  }

  let currentMachineId: string;
  try {
    currentMachineId = await getMachineId();
  } catch {
    throw new RegistrationError(
      "This computer's identity could not be read, so the licence cannot be checked. Restart the app and try again.",
    );
  }

  if (result.payload.machineId !== currentMachineId) {
    throw new RegistrationError(
      "This licence belongs to a different computer. Registration can only be managed on the laptop it was issued for.",
    );
  }

  return result.payload;
}

/**
 * Build the prefilled form from the existing records.
 *
 * `settings` is the live snapshot from `SettingsService`; `administrator` is
 * the existing user row. Neither is copied into a new table.
 */
export function readRegistrationDetails(
  administrator: AdministratorIdentity,
  settings: AppSettingsSnapshot,
  license: LicensePayload | null,
): RegistrationDetails {
  return {
    username: administrator.username,
    companyName: settings.companyName,
    companyTrn: settings.companyTrn,
    companyAddress: settings.companyAddress,
    companyPhone: settings.companyPhone,
    companyEmail: settings.companyEmail,
    ownerName: administrator.displayName,
    ownerEmail: administrator.email ?? "",
    ownerPhone: administrator.phone ?? "",
    licensedClientName: license?.clientName ?? "",
    edition: license?.edition ?? "",
    expiresAt: license?.expiresAt ?? null,
  };
}
