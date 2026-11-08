/**
 * The key generator and the app must agree on the key format.
 *
 * This file exists because they once did not, and nothing noticed. The two
 * halves each had their own copy of the rules - which bytes get signed, what
 * encoding they are in, what a pasted key is allowed to look like - and a key
 * produced by one could be rejected by the other with "invalid signature". The
 * existing `tests/license.test.ts` could not catch it either, because it
 * re-implemented the generator's signing code and mocked out the public key,
 * so both sides of the test were the test's own invention rather than the code
 * that ships.
 *
 * So the round trip here is deliberately end to end:
 *
 *   keygen's `buildLicenseKey`  ->  the app's `verifyLicenseKey`
 *
 * with the real `tools/keygen/private.key` and the real public key constant
 * that is compiled into the app. Nothing in between is mocked except Electron
 * and the hardware reader, which have nothing to do with the signature.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LICENSE_MESSAGES,
  createLicenseKey,
  normalizeLicenseKey,
  splitLicenseKey,
  type LicensePayload,
} from "../src/main/license-verify";
import {
  buildLicenseKey,
  derivePublicKeyPem,
  loadPrivateKey,
  privateKeyExists,
  readEmbeddedPublicKeyPem,
  verifyLicenseCommand,
} from "../tools/keygen/license-key";

const TEST_MACHINE_ID = "round-trip-machine-id";
const TEST_CLIENT = "minha water purification";

const harness = { userData: "" };

vi.mock("electron", () => ({
  app: { getPath: () => harness.userData, isPackaged: false },
}));

vi.mock("../src/main/machine-id", () => ({
  getMachineId: () => Promise.resolve(TEST_MACHINE_ID),
  warmMachineId: () => undefined,
  resetMachineIdCache: () => undefined,
}));

// Imported statically so the mocked Electron and machine id apply.
import { clearLicense, saveLicense, verifyLicenseKey } from "../src/main/license";

/** Issue a key through the generator, for this machine. */
function issueKey(options: { expires?: string | undefined } = {}): string {
  return buildLicenseKey({
    machine: TEST_MACHINE_ID,
    client: TEST_CLIENT,
    ...(options.expires === undefined ? {} : { expires: options.expires }),
  });
}

/**
 * Build a key straight from the signing module with the shipped private key.
 *
 * Used where the generator's own guard is in the way: it refuses to hand back
 * a key that does not verify, so an expired one - which is a perfectly valid
 * thing to test the expiry check with - has to be made here.
 */
function issueKeyBypassingSelfCheck(payload: Partial<LicensePayload> = {}): string {
  return createLicenseKey(
    {
      machineId: TEST_MACHINE_ID,
      clientName: TEST_CLIENT,
      issuedAt: new Date().toISOString(),
      expiresAt: null,
      edition: "standard",
      ...payload,
    },
    loadPrivateKey(),
  );
}

/** Split a key, failing the test loudly if it is not shaped like one. */
function mustSplit(key: string): { payloadSegment: string; signatureSegment: string } {
  const parts = splitLicenseKey(key);
  if (parts === null) throw new Error(`not a license key: ${key}`);
  return parts;
}

beforeAll(() => {
  harness.userData = mkdtempSync(join(tmpdir(), "eyerstock-keygen-test-"));
});

afterAll(() => {
  rmSync(harness.userData, { recursive: true, force: true });
});

describe("keypair shipped with the app", () => {
  // The drift that made every key useless: a private key whose public half is
  // not the one compiled into the app. Keys generated from it are correctly
  // signed and rejected by every build.
  it("private.key matches the public key embedded in the app source", () => {
    expect(privateKeyExists()).toBe(true);

    const derived = derivePublicKeyPem(loadPrivateKey());
    const embedded = readEmbeddedPublicKeyPem();

    expect(embedded).not.toBeNull();
    expect(embedded).toBe(derived);
  });

  it("keygen:check passes on the shipped keypair", () => {
    const result = verifyLicenseCommand({ key: issueKey() });

    expect(result.ok).toBe(true);
    expect(result.checks.find((check) => check.name === "signature")?.passed).toBe(true);
  });
});

describe("keygen -> app round trip", () => {
  beforeEach(() => {
    clearLicense();
  });

  it("a key from the generator activates in the app", async () => {
    const key = issueKey({ expires: "2027-12-31" });

    const result = await verifyLicenseKey(key);

    expect(result.error).toBeNull();
    expect(result.valid).toBe(true);
    expect(result.payload?.clientName).toBe(TEST_CLIENT);
    expect(result.payload?.machineId).toBe(TEST_MACHINE_ID);
  });

  it("a perpetual key activates in the app", async () => {
    const result = await verifyLicenseKey(issueKey());

    expect(result.valid).toBe(true);
    expect(result.payload?.expiresAt).toBeNull();
    expect(result.daysUntilExpiry).toBeNull();
  });

  it("an issued key survives the trip from terminal to input", async () => {
    // What a customer actually pastes. The generator prints the key on its own
    // line under a blank one, and keys reach users through email, where they
    // arrive wrapped in quotes and broken across lines.
    const key = issueKey();
    const pasted = `\n  ${key.slice(0, 40)}\n${key.slice(40)}\n`;

    const result = await verifyLicenseKey(pasted);

    expect(result.valid).toBe(true);
    expect(result.error).toBeNull();
  });

  it("an issued key wrapped in quotes still activates", async () => {
    const result = await verifyLicenseKey(`"${issueKey()}"`);

    expect(result.valid).toBe(true);
  });

  it("a key saved after activation is still accepted on the next launch", async () => {
    const key = issueKey();
    saveLicense(key);

    // What the next launch reads back from disk.
    const result = await verifyLicenseKey(key);

    expect(result.valid).toBe(true);
  });
});

describe("a key that was edited", () => {
  it("is rejected at the signature stage", async () => {
    const { payloadSegment, signatureSegment } = mustSplit(issueKey());
    const payload = JSON.parse(Buffer.from(payloadSegment, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    payload["clientName"] = "someone else";

    const forged = `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${signatureSegment}`;

    const result = await verifyLicenseKey(forged);

    expect(result.valid).toBe(false);
    expect(result.error).toBe(LICENSE_MESSAGES.signature);
  });

  it("is rejected when a character of the signature changes", async () => {
    const { payloadSegment, signatureSegment } = mustSplit(issueKey());

    // The first character, not the last: a 64-byte signature encodes to 86
    // base64url characters whose final one carries only padding bits, and Node
    // ignores those on decode. Editing it changes nothing, which is correct
    // and not what this test is about.
    const flipped = `${signatureSegment.startsWith("A") ? "B" : "A"}${signatureSegment.slice(1)}`;

    const result = await verifyLicenseKey(`${payloadSegment}.${flipped}`);

    expect(result.valid).toBe(false);
    expect(result.error).toBe(LICENSE_MESSAGES.signature);
  });

  it("is rejected when the signature is truncated", async () => {
    const { payloadSegment, signatureSegment } = mustSplit(issueKey());

    const result = await verifyLicenseKey(`${payloadSegment}.${signatureSegment.slice(0, 40)}`);

    expect(result.valid).toBe(false);
    expect(result.error).toBe(LICENSE_MESSAGES.signature);
  });

  it("is rejected when signed by a keypair the app does not hold", async () => {
    // Correct Ed25519, correctly formed, just not made by the key the app
    // embeds - the failure mode a mismatched keypair produces for every key.
    const foreign = generateKeyPairSync("ed25519", {
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });

    const other = buildLicenseKey({
      machine: TEST_MACHINE_ID,
      client: TEST_CLIENT,
      privateKeyPem: foreign.privateKey.toString(),
      publicKeyPem: foreign.publicKey.toString(),
    });

    const result = await verifyLicenseKey(other);

    expect(result.valid).toBe(false);
    expect(result.error).toBe(LICENSE_MESSAGES.signature);
  });
});

describe("the message names the check that failed", () => {
  it("a key for another computer says so", async () => {
    const key = issueKeyBypassingSelfCheck({ machineId: "a-different-computer" });

    const result = await verifyLicenseKey(key);

    expect(result.valid).toBe(false);
    expect(result.error).toBe(LICENSE_MESSAGES.machineId);
  });

  it("an expired key says so", async () => {
    const key = issueKeyBypassingSelfCheck({ expiresAt: "2020-01-01T00:00:00.000Z" });

    const result = await verifyLicenseKey(key);

    expect(result.valid).toBe(false);
    expect(result.error).toBe(LICENSE_MESSAGES.expiry);
  });

  it("text that is not a key says the format is wrong", async () => {
    const result = await verifyLicenseKey("please give me a licence");

    expect(result.valid).toBe(false);
    expect(result.error).toBe(LICENSE_MESSAGES.format);
  });

  it("a key with a payload that is not JSON says the format is wrong", async () => {
    const garbage = `${Buffer.from("not json at all").toString("base64url")}.${"A".repeat(86)}`;

    const result = await verifyLicenseKey(garbage);

    expect(result.valid).toBe(false);
    expect(result.error).toBe(LICENSE_MESSAGES.format);
  });

  it("keygen:verify reports every stage, not just the first failure", () => {
    const otherMachineAndExpired = issueKeyBypassingSelfCheck({
      machineId: "not-this-computer",
      expiresAt: "2020-01-01T00:00:00.000Z",
    });

    const result = verifyLicenseCommand({
      key: otherMachineAndExpired,
      machine: TEST_MACHINE_ID,
    });

    expect(result.ok).toBe(false);
    expect(result.checks.map((check) => check.name)).toEqual([
      "format",
      "signature",
      "machineId",
      "expiry",
    ]);
    expect(result.checks.find((check) => check.name === "signature")?.passed).toBe(true);
    expect(result.checks.find((check) => check.name === "machineId")?.passed).toBe(false);
    expect(result.checks.find((check) => check.name === "expiry")?.passed).toBe(false);
  });

  it("keygen:verify passes a key that is genuinely good", () => {
    const result = verifyLicenseCommand({ key: issueKey(), machine: TEST_MACHINE_ID });

    expect(result.ok).toBe(true);
    expect(result.checks.every((check) => check.passed)).toBe(true);
  });
});

describe("key normalisation", () => {
  it("removes wrapping quotes and surrounding whitespace", () => {
    expect(normalizeLicenseKey(`  "abc.def"  `)).toBe("abc.def");
    expect(normalizeLicenseKey(`'abc.def'`)).toBe("abc.def");
  });

  it("removes line breaks from the middle", () => {
    expect(normalizeLicenseKey("abc.\ndef")).toBe("abc.def");
  });

  it("leaves a clean key untouched", () => {
    expect(normalizeLicenseKey("abc.def")).toBe("abc.def");
  });

  it("rejects text with no separator", () => {
    expect(splitLicenseKey("no separator here")).toBeNull();
  });

  it("rejects a key with an empty half", () => {
    expect(splitLicenseKey(".signature")).toBeNull();
    expect(splitLicenseKey("payload.")).toBeNull();
  });
});
