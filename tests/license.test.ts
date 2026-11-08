/**
 * License verification tests.
 *
 * These exercise the real `src/main/license.ts` rather than a copy of its
 * logic. A copy is what let a genuine bug through: the shipped code called
 * `createVerify("ed25519")`, which throws `ERR_CRYPTO_INVALID_DIGEST`, so
 * every key - correct or not - failed with "Invalid digest". The test suite
 * had its own, correct reimplementation and passed the whole time.
 *
 * Only the two edges that need a machine are mocked: Electron (for the data
 * directory) and the hardware reader (so the test does not shell out).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_MACHINE_ID = "test-machine-id-123";

/**
 * A fixed keypair, used only by this file.
 *
 * It lives in `vi.hoisted` because `vi.mock` factories are hoisted above the
 * module body and cannot close over anything created during it - and the
 * literals avoid importing `node:crypto` there, which would need a `require`.
 *
 * Publishing this private key is harmless: it signs nothing but test data.
 */
const TEST_KEYS = vi.hoisted(() => ({
  privateKeyPem:
    "-----BEGIN PRIVATE KEY-----\n" +
    "MC4CAQAwBQYDK2VwBCIEIAopYtUOHQU96IYqOEDuBZQZ2GN1/FNfBrYRXcT4WyLj\n" +
    "-----END PRIVATE KEY-----\n",
  publicKeyBase64:
    "LS0tLS1CRUdJTiBQVUJMSUMgS0VZLS0tLS0KTUNvd0JRWURLMlZ3QXlFQWlWZ3h0Zm9kalE1UDRQN0hodGhYU3VSd0VNM3I1SE1jYTlkRzB0UWpyTnc9Ci0tLS0tRU5EIFBVQkxJQyBLRVktLS0tLQo=",
}));

/** The mocked Electron data folder; filled in before the tests run. */
const harness = { userData: "" };

vi.mock("electron", () => ({
  app: {
    getPath: () => harness.userData,
    isPackaged: false,
  },
}));

vi.mock("../src/main/machine-id", () => ({
  getMachineId: () => Promise.resolve(TEST_MACHINE_ID),
  warmMachineId: () => undefined,
  resetMachineIdCache: () => undefined,
}));

// The real module embeds a generated public key; the tests need their own, so
// the constant is replaced with the one matching the test keypair.
vi.mock("../src/main/license-public-key", () => ({
  LICENSE_PUBLIC_KEY: TEST_KEYS.publicKeyBase64,
}));

// Imported statically: `vi.mock` is hoisted above imports, so this module
// receives the mocked Electron and public key rather than the real ones.
import { LICENSE_MESSAGES } from "../src/main/license-verify";
import {
  clearLicense,
  loadAndVerifyLicense,
  saveLicense,
  verifyLicenseKey,
} from "../src/main/license";

beforeAll(() => {
  harness.userData = mkdtempSync(join(tmpdir(), "eyerstock-license-test-"));
});

afterAll(() => {
  rmSync(harness.userData, { recursive: true, force: true });
});

interface LicensePayload {
  machineId: string;
  clientName: string;
  issuedAt: string;
  expiresAt: string | null;
  edition: string;
}

function base64urlEncode(data: Buffer): string {
  return data.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function createLicenseKey(payload: LicensePayload, privateKeyPem: string): string {
  const payloadB64 = base64urlEncode(Buffer.from(JSON.stringify(payload)));
  const signature = sign(null, Buffer.from(payloadB64), privateKeyPem);
  return `${payloadB64}.${base64urlEncode(signature)}`;
}

const { privateKeyPem: privateKey } = TEST_KEYS;

const testPayload: LicensePayload = {
  machineId: TEST_MACHINE_ID,
  clientName: "Test Customer",
  issuedAt: "2026-10-10T10:00:00.000Z",
  expiresAt: "2027-12-31T23:59:59.999Z",
  edition: "standard",
};

describe("license verification", () => {
  beforeEach(() => {
    clearLicense();
  });

  // The regression that mattered: Ed25519 has no digest, so this must not
  // throw and must not reject a correctly signed key.
  it("valid key passes verification", async () => {
    const result = await verifyLicenseKey(createLicenseKey(testPayload, privateKey));

    expect(result.error).toBeNull();
    expect(result.valid).toBe(true);
    expect(result.payload?.clientName).toBe("Test Customer");
    expect(result.payload?.machineId).toBe(TEST_MACHINE_ID);
    expect(result.daysUntilExpiry).toBeGreaterThan(0);
  });

  it("modified payload fails verification", async () => {
    const key = createLicenseKey(testPayload, privateKey);
    const [payloadB64, signatureB64] = key.split(".") as [string, string];
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    payload.clientName = "Hacker";
    const tamperedKey = `${base64urlEncode(Buffer.from(JSON.stringify(payload)))}.${signatureB64}`;

    const result = await verifyLicenseKey(tamperedKey);

    expect(result.valid).toBe(false);
    expect(result.error).toBe(LICENSE_MESSAGES.signature);
  });

  it("wrong machine ID fails verification", async () => {
    const key = createLicenseKey({ ...testPayload, machineId: "different-machine-id" }, privateKey);

    const result = await verifyLicenseKey(key);

    expect(result.valid).toBe(false);
    expect(result.error).toBe(LICENSE_MESSAGES.machineId);
  });

  it("expired key fails verification", async () => {
    const key = createLicenseKey(
      { ...testPayload, expiresAt: "2020-01-01T00:00:00.000Z" },
      privateKey,
    );

    const result = await verifyLicenseKey(key);

    expect(result.valid).toBe(false);
    expect(result.error).toBe(LICENSE_MESSAGES.expiry);
  });

  it("perpetual license has no expiry", async () => {
    const result = await verifyLicenseKey(
      createLicenseKey({ ...testPayload, expiresAt: null }, privateKey),
    );

    expect(result.valid).toBe(true);
    expect(result.daysUntilExpiry).toBeNull();
    expect(result.payload?.expiresAt).toBeNull();
  });

  it("expiring soon flag is set within 14 days", async () => {
    const soonExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const key = createLicenseKey({ ...testPayload, expiresAt: soonExpiry }, privateKey);

    const result = await verifyLicenseKey(key);

    expect(result.valid).toBe(true);
    expect(result.isExpiringSoon).toBe(true);
    expect(result.daysUntilExpiry).toBeLessThanOrEqual(14);
  });

  it("expiring soon flag is not set beyond 14 days", async () => {
    const farExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const key = createLicenseKey({ ...testPayload, expiresAt: farExpiry }, privateKey);

    const result = await verifyLicenseKey(key);

    expect(result.valid).toBe(true);
    expect(result.isExpiringSoon).toBe(false);
  });

  it("key signed with a different private key fails", async () => {
    const { privateKey: otherPrivateKey } = generateKeyPairSync("ed25519", {
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });

    const result = await verifyLicenseKey(createLicenseKey(testPayload, otherPrivateKey));

    expect(result.valid).toBe(false);
    expect(result.error).toBe(LICENSE_MESSAGES.signature);
  });

  it("malformed key format fails", async () => {
    const result = await verifyLicenseKey("not-a-valid-key");

    expect(result.valid).toBe(false);
    expect(result.error).toBe(LICENSE_MESSAGES.format);
  });

  it("a key pasted with whitespace and quotes still verifies", async () => {
    // The regression that sent this to a customer: the payload decoded fine
    // (base64 decoding ignores whitespace) but the signature was checked over
    // the untrimmed text, so a key with a stray leading newline was reported
    // as a bad signature.
    const key = createLicenseKey(testPayload, privateKey);

    for (const pasted of [key, `\n${key}`, `  ${key}  `, `"${key}"`, `"\n${key}\n"`]) {
      const result = await verifyLicenseKey(pasted);
      expect(result.valid, `pasted as ${JSON.stringify(pasted)}`).toBe(true);
    }
  });

  it("key with invalid JSON payload fails", async () => {
    const invalidPayloadB64 = base64urlEncode(Buffer.from("not valid json"));
    const { privateKey: pk } = generateKeyPairSync("ed25519", {
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const key = `${invalidPayloadB64}.${base64urlEncode(sign(null, Buffer.from(invalidPayloadB64), pk))}`;

    const result = await verifyLicenseKey(key);

    expect(result.valid).toBe(false);
    expect(result.error).toBe(LICENSE_MESSAGES.format);
  });

  it("never leaks a raw internal error instead of a shop-facing reason", async () => {
    // Whatever the input, the failure must be described in words a shopkeeper
    // can act on rather than a Node error code.
    for (const input of ["", "x", "a.b.c.d", "...", Buffer.from("{}").toString("base64url")]) {
      const result = await verifyLicenseKey(input);
      expect(result.valid).toBe(false);
      expect(result.error).not.toMatch(/digest|Cannot read|undefined|JSON/i);
    }
  });
});

describe("stored license", () => {
  beforeEach(() => {
    clearLicense();
  });

  it("a saved key is accepted on the next launch", async () => {
    const key = createLicenseKey(testPayload, privateKey);
    saveLicense(key);

    const result = await loadAndVerifyLicense();

    expect(result.valid).toBe(true);
    expect(result.payload?.clientName).toBe("Test Customer");
  });

  it("no stored license reports no license found", async () => {
    const result = await loadAndVerifyLicense();

    expect(result.valid).toBe(false);
    expect(result.error).toBe("No license found");
  });

  it("a rolled-back system clock is refused", async () => {
    const key = createLicenseKey(testPayload, privateKey);
    saveLicense(key);

    const file = join(harness.userData, "license.json");
    const stored = JSON.parse(readFileSync(file, "utf8"));
    const future = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
    writeFileSync(file, JSON.stringify({ ...stored, lastSeenAt: future }), "utf8");

    const result = await loadAndVerifyLicense();

    expect(result.valid).toBe(false);
    expect(result.error).toContain("clock");
  });

  it("a corrupt primary file falls back to the backup", async () => {
    const key = createLicenseKey(testPayload, privateKey);
    saveLicense(key);
    writeFileSync(join(harness.userData, "license.json"), "{ not json", "utf8");

    expect(existsSync(join(harness.userData, "license.backup.json"))).toBe(true);
    const result = await loadAndVerifyLicense();

    expect(result.valid).toBe(true);
  });

  it("clearing removes both copies", () => {
    saveLicense(createLicenseKey(testPayload, privateKey));
    clearLicense();

    expect(existsSync(join(harness.userData, "license.json"))).toBe(false);
    expect(existsSync(join(harness.userData, "license.backup.json"))).toBe(false);
  });
});
