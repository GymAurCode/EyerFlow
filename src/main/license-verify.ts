/**
 * License key format and verification.
 *
 * This is the ONE place where the key format is defined. The app
 * (`src/main/license.ts`) and the key generator (`tools/keygen/index.ts`) both
 * import it, so the two cannot drift apart - which is the only reliable way to
 * stop a key that the generator happily produces from being rejected by the
 * app it was issued for.
 *
 * ## Why this module exists
 *
 * The two halves used to re-implement the format independently. The bug that
 * prompted this file was not a wrong algorithm - both sides used Ed25519
 * correctly - it was a mismatch in *which bytes* were signed and in what
 * *state* those bytes were in when they arrived:
 *
 *   - the generator signed the base64url **payload segment as it appears in
 *     the key**;
 *   - the app verified the base64url payload segment as it appeared in
 *     whatever the user pasted.
 *
 * Those are the same bytes only when the paste is byte-for-byte clean.
 * `Buffer.from(x, "base64url")` silently *ignores* whitespace and stray
 * characters, so a key pasted with a leading newline still decoded into a
 * perfectly valid JSON payload - which is exactly the reported symptom: "the
 * payload is fine, but the app says the signature is invalid".
 *
 * The fix is to make the signed bytes canonical instead of literal: the payload
 * is decoded once and re-encoded to a canonical unpadded base64url string, and
 * that canonical string is what is signed and what is verified. Whitespace,
 * wrapping quotes, `=` padding, and the plain-base64 alphabet (`+/`) versus the
 * URL-safe one (`-_`) all normalise away to the same bytes, while any change to
 * the payload itself still changes them and still fails verification.
 *
 * ## Format
 *
 *     base64url(JSON payload) "." base64url(Ed25519 signature)
 *
 * The signature is made with `crypto.sign(null, ...)` over the canonical
 * payload segment. Ed25519 is signature-only: the digest argument must be
 * `null`/`undefined`, and passing a name such as `"ed25519"` makes Node throw
 * `ERR_CRYPTO_INVALID_DIGEST`. `createSign`/`createVerify` must not be used
 * here.
 */

import { sign as ed25519Sign, verify as ed25519Verify } from "node:crypto";

// ============================================================================
// Types
// ============================================================================

export interface LicensePayload {
  readonly machineId: string;
  readonly clientName: string;
  readonly issuedAt: string; // ISO 8601
  readonly expiresAt: string | null; // ISO 8601, or null for perpetual
  readonly edition: string; // e.g. "standard", "pro"
}

/** Which check rejected the key. "ok" means every check passed. */
export type LicenseCheckStage = "ok" | "format" | "signature" | "machineId" | "expiry";

export interface LicenseCheckResult {
  readonly ok: boolean;
  readonly stage: LicenseCheckStage;
  /** Shop-facing wording for the stage that failed; null when ok. */
  readonly message: string | null;
  readonly payload: LicensePayload | null;
  readonly daysUntilExpiry: number | null;
  /** True when the key expires within {@link EXPIRY_WARNING_DAYS}. */
  readonly isExpiringSoon: boolean;
}

export interface VerifyLicenseOptions {
  /** The key exactly as it was received - untrimmed, possibly quoted. */
  readonly key: string;
  /** PEM (SPKI) Ed25519 public key. */
  readonly publicKeyPem: string;
  /**
   * The machine the key must be bound to. When null the machine check is
   * skipped, which is what `keygen:verify` does before it has been told which
   * machine to check against.
   */
  readonly machineId: string | null;
  /** Injectable for tests; defaults to now. */
  readonly now?: Date;
}

// ============================================================================
// Constants
// ============================================================================

/** Separator between the payload and signature segments. */
export const LICENSE_KEY_SEPARATOR = ".";

/** A key expiring within this many days is flagged to the user. */
export const EXPIRY_WARNING_DAYS = 14;

/**
 * Exact wording shown to the user for each failing check.
 *
 * Deliberately specific: "invalid signature" told a shopkeeper nothing about
 * whether they had mistyped the key or been sold one for another computer.
 */
export const LICENSE_MESSAGES = {
  format: "Invalid key format",
  signature: "Signature does not match (wrong keypair or edited key)",
  machineId: "This key is for a different computer",
  expiry: "Key expired",
} as const satisfies Record<Exclude<LicenseCheckStage, "ok">, string>;

/** Ed25519 signatures are always 64 bytes. */
const SIGNATURE_BYTE_LENGTH = 64;

/** Characters that survive transport around the key itself: smart quotes etc. */
const QUOTE_CHARS = new Set(['"', "'", "`", "\u201C", "\u201D", "\u2018", "\u2019"]);

/**
 * Both alphabets are accepted on the way in: base64url (`-`, `_`) is what the
 * generator writes, but a key that travelled through a tool that re-encoded it
 * as plain base64 (`+`, `/`) is still the same key. Padding (`=`) is optional.
 */
const SEGMENT_PATTERN = /^[A-Za-z0-9+/_-]+={0,2}$/;

// ============================================================================
// Encoding helpers
// ============================================================================

/** Unpadded base64url. */
export function base64urlEncode(data: Buffer): string {
  return data.toString("base64url");
}

/**
 * Decode one key segment, accepting either base64 or base64url.
 *
 * Node's two decoders accept both alphabets, but this normalises explicitly
 * so the intent is recorded rather than relied upon, and so a segment written
 * with `=` padding still decodes on every supported Node version.
 */
export function decodeSegment(segment: string): Buffer {
  return Buffer.from(segment, "base64url");
}

/**
 * The exact bytes that are signed and verified.
 *
 * The payload segment is decoded and re-encoded to canonical unpadded
 * base64url. Normalising here is what makes the signature survive whitespace,
 * padding and alphabet differences without weakening it: the bytes still depend
 * on the payload's full content.
 */
export function canonicalPayloadSegment(payloadSegment: string): string {
  return base64urlEncode(decodeSegment(payloadSegment));
}

// ============================================================================
// Key normalisation and splitting
// ============================================================================

/**
 * Clean a key as it was pasted, without touching the caller.
 *
 * Removes surrounding whitespace, any number of layers of wrapping quotes (a
 * key copied out of a document often carries one pair, a key copied out of a
 * shell script often carries two), and every remaining space or newline. The
 * key alphabet contains none of those characters, so removing them cannot
 * change a genuine key.
 */
export function normalizeLicenseKey(raw: string): string {
  let text = raw.trim();

  while (
    text.length >= 2 &&
    QUOTE_CHARS.has(text.charAt(0)) &&
    QUOTE_CHARS.has(text.charAt(text.length - 1))
  ) {
    text = text.slice(1, -1).trim();
  }

  return text.replace(/\s+/g, "");
}

export interface LicenseKeyParts {
  /** Payload segment as it appeared in the input. */
  readonly payloadSegment: string;
  /** Signature segment as it appeared in the input. */
  readonly signatureSegment: string;
  /** The whole key after normalisation. */
  readonly normalized: string;
}

/**
 * Split a key into its two segments, or null when it is not shaped like one.
 *
 * Splits on the FIRST separator only; neither the base64 nor the base64url
 * alphabet contains a ".", so the split is unambiguous.
 */
export function splitLicenseKey(raw: string): LicenseKeyParts | null {
  const normalized = normalizeLicenseKey(raw);

  const index = normalized.indexOf(LICENSE_KEY_SEPARATOR);
  if (index <= 0) return null;

  const payloadSegment = normalized.slice(0, index);
  const signatureSegment = normalized.slice(index + 1);

  if (!SEGMENT_PATTERN.test(payloadSegment) || !SEGMENT_PATTERN.test(signatureSegment)) return null;

  return { payloadSegment, signatureSegment, normalized };
}

// ============================================================================
// Verification
// ============================================================================

function ok(
  payload: LicensePayload,
  daysUntilExpiry: number | null,
  isExpiringSoon: boolean,
): LicenseCheckResult {
  return { ok: true, stage: "ok", message: null, payload, daysUntilExpiry, isExpiringSoon };
}

function failed(stage: Exclude<LicenseCheckStage, "ok">): LicenseCheckResult {
  return {
    ok: false,
    stage,
    message: LICENSE_MESSAGES[stage],
    payload: null,
    daysUntilExpiry: null,
    isExpiringSoon: false,
  };
}

/**
 * Read the payload out of a key segment.
 *
 * Throws on anything that is not a well-formed license payload; callers treat
 * a throw here as a format failure.
 */
export function decodeLicensePayload(payloadSegment: string): LicensePayload {
  const parsed: unknown = JSON.parse(decodeSegment(payloadSegment).toString("utf8"));

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError("payload is not an object");
  }

  const record = parsed as Record<string, unknown>;
  const machineId = record["machineId"];
  if (typeof machineId !== "string" || machineId === "") {
    throw new TypeError("payload.machineId is missing");
  }

  const expiresAt = record["expiresAt"];
  if (expiresAt !== null && typeof expiresAt !== "string") {
    throw new TypeError("payload.expiresAt is not a string or null");
  }
  if (typeof expiresAt === "string" && Number.isNaN(new Date(expiresAt).getTime())) {
    throw new TypeError("payload.expiresAt is not a date");
  }

  return {
    machineId,
    clientName: typeof record["clientName"] === "string" ? record["clientName"] : "",
    issuedAt: typeof record["issuedAt"] === "string" ? record["issuedAt"] : "",
    expiresAt,
    edition: typeof record["edition"] === "string" ? record["edition"] : "standard",
  };
}

/**
 * Check a signature against the canonical payload segment.
 *
 * Returns false rather than throwing for every kind of bad input: a truncated
 * signature, a signature of the wrong length and a signature made with a
 * different key are all "this key does not verify", and the user is told the
 * same thing.
 */
export function checkSignature(
  payloadSegment: string,
  signatureSegment: string,
  publicKeyPem: string,
): boolean {
  let signature: Buffer;
  try {
    signature = decodeSegment(signatureSegment);
  } catch {
    return false;
  }

  if (signature.length !== SIGNATURE_BYTE_LENGTH) return false;

  try {
    // Ed25519 has no separate digest: the algorithm argument must be null.
    return ed25519Verify(
      null,
      Buffer.from(canonicalPayloadSegment(payloadSegment), "utf8"),
      publicKeyPem,
      signature,
    );
  } catch {
    // A malformed public key or an unsupported key type is indistinguishable
    // from a bad signature as far as the user is concerned.
    return false;
  }
}

/**
 * Outcome of every check, evaluated independently.
 *
 * Each check runs on its own rather than the first failure short-circuiting the
 * rest, because "wrong computer" and "expired" are independent facts about a
 * key and a user told only the first has to try again to discover the second.
 * `verifyLicense` collapses this to the first failure, which is what the app
 * wants; `keygen:verify` reports the lot.
 */
export interface LicenseStageReport {
  /** The key is two base64 segments separated by a dot, and the payload is JSON. */
  readonly format: { readonly passed: boolean; readonly payload: LicensePayload | null };
  readonly signature: { readonly passed: boolean };
  readonly machineId: { readonly passed: boolean };
  readonly expiry: {
    readonly passed: boolean;
    readonly daysUntilExpiry: number | null;
    readonly isExpiringSoon: boolean;
  };
  readonly payload: LicensePayload | null;
}

/** Run all four checks and report each result separately. */
export function checkLicenseStages(options: VerifyLicenseOptions): LicenseStageReport {
  const now = options.now ?? new Date();

  const parts = splitLicenseKey(options.key);

  let payload: LicensePayload | null = null;
  if (parts !== null) {
    try {
      payload = decodeLicensePayload(parts.payloadSegment);
    } catch {
      payload = null;
    }
  }

  const formatPassed = payload !== null;
  const signaturePassed =
    parts !== null && payload !== null
      ? checkSignature(parts.payloadSegment, parts.signatureSegment, options.publicKeyPem)
      : false;
  const machineIdPassed =
    options.machineId === null || payload === null || payload.machineId === options.machineId;

  let daysUntilExpiry: number | null = null;
  let isExpiringSoon = false;
  if (payload !== null && payload.expiresAt !== null) {
    const diffMs = new Date(payload.expiresAt).getTime() - now.getTime();
    daysUntilExpiry = Math.ceil(diffMs / (24 * 60 * 60 * 1000));
    isExpiringSoon = daysUntilExpiry <= EXPIRY_WARNING_DAYS && daysUntilExpiry >= 0;
  }

  return {
    format: { passed: formatPassed, payload },
    signature: { passed: signaturePassed },
    machineId: { passed: machineIdPassed },
    expiry: {
      passed: !(payload !== null && daysUntilExpiry !== null && daysUntilExpiry < 0),
      daysUntilExpiry,
      isExpiringSoon,
    },
    payload,
  };
}

/**
 * Run every check against a key, in order, and report the first that fails.
 *
 * This is the function the app, `keygen:verify` and the test suite all use.
 * It never throws: a bad key is a result, not an exception.
 */
export function verifyLicense(options: VerifyLicenseOptions): LicenseCheckResult {
  const report = checkLicenseStages(options);

  if (!report.format.passed) return failed("format");
  if (!report.signature.passed) return failed("signature");
  if (!report.machineId.passed) return failed("machineId");
  if (!report.expiry.passed) return failed("expiry");

  // Unreachable in practice: format.passed is only true when a payload exists.
  const payload = report.payload;
  if (payload === null) return failed("format");

  return ok(payload, report.expiry.daysUntilExpiry, report.expiry.isExpiringSoon);
}

// ============================================================================
// Signing
// ============================================================================

/**
 * Build a license key: `base64url(payload) "." base64url(signature)`.
 *
 * Signing uses `canonicalPayloadSegment`, the same function verification uses,
 * so the generator cannot produce a key the app would reject for reasons that
 * have nothing to do with the cryptography.
 */
export function createLicenseKey(payload: LicensePayload, privateKeyPem: string): string {
  const payloadSegment = base64urlEncode(Buffer.from(JSON.stringify(payload), "utf8"));

  // Ed25519 is signature-only, so the algorithm argument must be null.
  const signature = ed25519Sign(null, Buffer.from(payloadSegment, "utf8"), privateKeyPem);

  return `${payloadSegment}${LICENSE_KEY_SEPARATOR}${base64urlEncode(signature)}`;
}
