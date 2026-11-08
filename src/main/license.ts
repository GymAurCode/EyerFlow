/**
 * Offline license verification using Ed25519 signatures.
 *
 * License key format: base64url(payload) + "." + base64url(signature)
 * Payload: { machineId, clientName, issuedAt, expiresAt?, edition }
 *
 * The app embeds ONLY the public key. Verification checks:
 * 1. Signature is valid for the payload using the embedded public key
 * 2. Payload.machineId matches the current machine's ID
 * 3. License is not expired (if expiresAt is set)
 * 4. Clock rollback detection via stored last-seen timestamp
 *
 * The format itself - which bytes are signed, how the key is decoded, what each
 * failure is called - lives in `license-verify.ts`, which the key generator
 * imports as well. That module is deliberately separate from this one because
 * it is the security-critical part and must stay free of Electron and
 * filesystem dependencies; see the note there for what drifted before.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { app } from "electron";
import { getMachineId } from "./machine-id";
import { LICENSE_PUBLIC_KEY } from "./license-public-key";
import { normalizeLicenseKey, verifyLicense, type LicensePayload } from "./license-verify";

export type { LicensePayload } from "./license-verify";
export { EXPIRY_WARNING_DAYS, LICENSE_MESSAGES } from "./license-verify";

// The public key is base64-encoded PEM. Accept base64url here too: the
// constant is generated as base64, but a hand-edited or re-encoded file should
// not be able to produce a key that silently fails to load.
const PUBLIC_KEY_PEM = decodeEmbeddedPublicKey(LICENSE_PUBLIC_KEY);

function decodeEmbeddedPublicKey(encoded: string): string {
  const pem = Buffer.from(encoded.trim(), "base64").toString("utf8");
  const looksLikePem = pem.includes("-----BEGIN");
  if (!looksLikePem) {
    // Not base64-of-PEM after all; the value may be the PEM itself.
    return encoded.trim();
  }
  return pem;
}

// ============================================================================
// PUBLIC KEY - EMBEDDED AT BUILD TIME BY keygen:init
// ============================================================================
// This constant is replaced by the keygen tool. DO NOT EDIT MANUALLY.
// The keygen:init script writes the actual public key to license-public-key.ts.

// ============================================================================
// Types
// ============================================================================

// `LicensePayload` is re-exported from license-verify.ts so there is a single
// definition of the shape that is both signed and read.

export interface LicenseInfo {
  readonly valid: boolean;
  readonly payload: LicensePayload | null;
  readonly error: string | null;
  readonly daysUntilExpiry: number | null;
  readonly isExpiringSoon: boolean; // within 14 days
}

export interface StoredLicense {
  readonly key: string;
  readonly activatedAt: string; // ISO 8601
  readonly lastSeenAt: string; // ISO 8601 for clock-rollback detection
}

// ============================================================================
// Constants
// ============================================================================

const LICENSE_FILE_NAME = "license.json";
const LICENSE_BACKUP_FILE_NAME = "license.backup.json";
const CLOCK_ROLLBACK_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours
const REVERIFICATION_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ============================================================================
// License file paths
// ============================================================================

function getLicensePaths(): { primary: string; backup: string } {
  const userData = app.getPath("userData");
  return {
    primary: join(userData, LICENSE_FILE_NAME),
    backup: join(userData, LICENSE_BACKUP_FILE_NAME),
  };
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Verify a license key string.
 *
 * Accepts a key exactly as it was pasted: leading and trailing whitespace,
 * wrapping quotes and a line break in the middle are all removed before the key
 * is looked at. This used to be done by the screen that collects the key, which
 * meant any other caller - and any paste the screen's single `trim()` did not
 * cover, such as a key copied out of a document that kept its quotes - was
 * rejected with "invalid signature" even though the key was perfect.
 *
 * Returns LicenseInfo with validation result. Never throws.
 */
export async function verifyLicenseKey(key: string): Promise<LicenseInfo> {
  try {
    // Normalise first: the canonical bytes that were signed are derived from a
    // clean key, so a key that merely travelled badly still verifies.
    const normalized = normalizeLicenseKey(key);

    const currentMachineId = await getMachineId();

    const result = verifyLicense({
      key: normalized,
      publicKeyPem: PUBLIC_KEY_PEM,
      machineId: currentMachineId,
    });

    return {
      valid: result.ok,
      payload: result.payload,
      error: result.message,
      daysUntilExpiry: result.daysUntilExpiry,
      isExpiringSoon: result.isExpiringSoon,
    };
  } catch (error) {
    // Reading the machine ID shells out to the OS and can fail on its own. It
    // is reported as a verification failure rather than left to escape as an
    // exception across the bridge.
    return {
      valid: false,
      payload: null,
      error: `License verification failed: ${error instanceof Error ? error.message : String(error)}`,
      daysUntilExpiry: null,
      isExpiringSoon: false,
    };
  }
}

/**
 * Load and verify the stored license.
 * Performs clock-rollback detection.
 */
export async function loadAndVerifyLicense(): Promise<LicenseInfo> {
  const { primary, backup } = getLicensePaths();

  // Try primary
  let stored: StoredLicense | null = null;
  try {
    if (existsSync(primary)) {
      stored = JSON.parse(readFileSync(primary, "utf8")) as StoredLicense;
    }
  } catch {
    // Ignore, try backup
  }

  // Try backup if primary failed
  if (!stored) {
    try {
      if (existsSync(backup)) {
        stored = JSON.parse(readFileSync(backup, "utf8")) as StoredLicense;
      }
    } catch {
      // Both failed
    }
  }

  if (!stored) {
    return {
      valid: false,
      payload: null,
      error: "No license found",
      daysUntilExpiry: null,
      isExpiringSoon: false,
    };
  }

  // Clock rollback detection
  const lastSeen = new Date(stored.lastSeenAt).getTime();
  const now = Date.now();
  if (lastSeen > now + CLOCK_ROLLBACK_THRESHOLD_MS) {
    return {
      valid: false,
      payload: null,
      error: "System clock appears to have been rolled back. Please re-activate.",
      daysUntilExpiry: null,
      isExpiringSoon: false,
    };
  }

  // Verify the key
  const result = await verifyLicenseKey(stored.key);

  // Update lastSeenAt if valid
  if (result.valid) {
    updateLastSeen(stored.key);
  }

  return result;
}

/**
 * Save a license key to both primary and backup locations.
 *
 * The key is normalised on the way in, so what is written to disk is exactly
 * the canonical key that was verified - not whatever the paste happened to
 * look like.
 */
export function saveLicense(key: string): void {
  const { primary, backup } = getLicensePaths();
  const stored: StoredLicense = {
    key: normalizeLicenseKey(key),
    activatedAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
  };

  mkdirSync(dirname(primary), { recursive: true });

  const json = JSON.stringify(stored, null, 2);
  writeFileSync(primary, json, "utf8");
  writeFileSync(backup, json, "utf8");
}

/**
 * Update the lastSeenAt timestamp (for clock-rollback detection).
 */
export function updateLastSeen(key: string): void {
  const { primary, backup } = getLicensePaths();

  let activatedAt = new Date().toISOString();

  // Read existing to preserve activatedAt
  try {
    if (existsSync(primary)) {
      const existing = JSON.parse(readFileSync(primary, "utf8")) as {
        readonly activatedAt?: string | undefined;
      };
      activatedAt = existing.activatedAt ?? activatedAt;
    }
  } catch {
    // Ignore
  }

  const stored: StoredLicense = {
    key: normalizeLicenseKey(key),
    activatedAt,
    lastSeenAt: new Date().toISOString(),
  };

  const json = JSON.stringify(stored, null, 2);
  writeFileSync(primary, json, "utf8");
  writeFileSync(backup, json, "utf8");
}

/**
 * Clear the stored license (for testing or deactivation).
 */
export function clearLicense(): void {
  const { primary, backup } = getLicensePaths();
  try {
    rmSync(primary, { force: true });
  } catch {
    // Already gone, or the file is locked: clearing is best-effort.
  }
  try {
    rmSync(backup, { force: true });
  } catch {
    // As above.
  }
}

/**
 * Check if license is disabled via environment variable (dev only).
 */
export function isLicenseDisabled(): boolean {
  return process.env.LICENCE_DISABLED === "1" && !app.isPackaged;
}

/**
 * Get license status for display in Settings > About.
 */
export async function getLicenseStatus(): Promise<{
  clientName: string;
  expiresAt: string | null;
  machineId: string;
  daysUntilExpiry: number | null;
  isExpiringSoon: boolean;
} | null> {
  const result = await loadAndVerifyLicense();
  if (!result.valid || !result.payload) return null;

  return {
    clientName: result.payload.clientName,
    expiresAt: result.payload.expiresAt,
    machineId: result.payload.machineId,
    daysUntilExpiry: result.daysUntilExpiry,
    isExpiringSoon: result.isExpiringSoon,
  };
}

// ============================================================================
// Periodic re-verification
// ============================================================================

let reverifyInterval: NodeJS.Timeout | null = null;

export function startPeriodicReverification(onInvalid: () => void): void {
  if (reverifyInterval !== null) return;

  reverifyInterval = setInterval(() => {
    void loadAndVerifyLicense().then((result) => {
      if (!result.valid) {
        onInvalid();
      }
    });
  }, REVERIFICATION_INTERVAL_MS);

  // Don't prevent app exit
  reverifyInterval.unref?.();
}

export function stopPeriodicReverification(): void {
  if (reverifyInterval !== null) {
    clearInterval(reverifyInterval);
    reverifyInterval = null;
  }
}
