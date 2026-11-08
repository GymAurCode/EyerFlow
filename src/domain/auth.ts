/**
 * Password hashing, strength policy, and login lockout arithmetic.
 *
 * scrypt from node:crypto is used rather than a third-party KDF so the app has
 * no additional native or supply-chain surface. All comparisons are constant
 * time, and the lockout maths is kept pure so it can be unit tested without a
 * database or an Electron app.
 */

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/** scrypt work factors. Tuned for a low-end shop PC: ~100ms per hash. */
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_COST = 16_384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELISM = 1;

export interface PasswordHash {
  readonly hash: string;
  readonly salt: string;
}

export function hashPassword(password: string, salt?: string): PasswordHash {
  const useSalt = salt ?? randomBytes(16).toString("hex");
  const derived = scryptSync(password, useSalt, SCRYPT_KEY_LENGTH, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK_SIZE,
    p: SCRYPT_PARALLELISM,
  });
  return { hash: derived.toString("hex"), salt: useSalt };
}

/** Constant-time verification; returns false for any malformed input. */
export function verifyPassword(password: string, stored: PasswordHash): boolean {
  if (!/^[0-9a-f]{128}$/.test(stored.hash) || !/^[0-9a-f]{32}$/.test(stored.salt)) {
    return false;
  }
  const candidate = hashPassword(password, stored.salt).hash;
  const a = Buffer.from(candidate, "hex");
  const b = Buffer.from(stored.hash, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface PasswordPolicy {
  readonly minLength: number;
  readonly requireUpper: boolean;
  readonly requireLower: boolean;
  readonly requireDigit: boolean;
  readonly requireSymbol: boolean;
}

export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = {
  minLength: 8,
  requireUpper: true,
  requireLower: true,
  requireDigit: true,
  requireSymbol: false,
};

export type PasswordPolicyResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * Validate a new password against the policy.
 *
 * Messages name the failing rule because they are shown directly under the
 * password field; staff should not have to guess what "weak" means.
 */
export function checkPasswordPolicy(
  password: string,
  policy: PasswordPolicy = DEFAULT_PASSWORD_POLICY,
): PasswordPolicyResult {
  if (password.length < policy.minLength) {
    return { ok: false, reason: `Use at least ${String(policy.minLength)} characters.` };
  }
  if (policy.requireUpper && !/[A-Z]/.test(password)) {
    return { ok: false, reason: "Add at least one capital letter." };
  }
  if (policy.requireLower && !/[a-z]/.test(password)) {
    return { ok: false, reason: "Add at least one small letter." };
  }
  if (policy.requireDigit && !/[0-9]/.test(password)) {
    return { ok: false, reason: "Add at least one number." };
  }
  if (policy.requireSymbol && !/[^A-Za-z0-9]/.test(password)) {
    return { ok: false, reason: "Add at least one symbol such as ! or @." };
  }
  return { ok: true };
}

export const DEFAULT_LOCKOUT = {
  /** Consecutive failures before the account is locked. */
  threshold: 5,
  /** Lock duration in minutes. */
  lockMinutes: 15,
} as const;

export interface LockoutDecision {
  readonly locked: boolean;
  /** ISO timestamp when the lock expires, when locked. */
  readonly untilIso: string | null;
  readonly remainingAttempts: number;
  readonly message: string | null;
}

export function evaluateLockout(
  failedAttempts: number,
  lockedUntilIso: string | null,
  now: Date,
  threshold: number = DEFAULT_LOCKOUT.threshold,
): LockoutDecision {
  if (lockedUntilIso !== null) {
    const until = Date.parse(lockedUntilIso);
    if (!Number.isNaN(until) && until > now.getTime()) {
      // The duration comes from the stored expiry rather than being recomputed,
      // so a policy change mid-lock does not shorten an existing lock.
      const minutes = Math.max(1, Math.ceil((until - now.getTime()) / 60_000));
      return {
        locked: true,
        untilIso: lockedUntilIso,
        remainingAttempts: 0,
        message: `Too many wrong attempts. Try again in ${String(minutes)} minute(s).`,
      };
    }
  }

  const remaining = Math.max(0, threshold - failedAttempts);
  return {
    locked: false,
    untilIso: null,
    remainingAttempts: remaining,
    message:
      remaining <= 2
        ? `After ${String(threshold)} wrong attempts the account locks. ${String(remaining)} left.`
        : null,
  };
}

/** ISO timestamp for `lockMinutes` from now, used to set `users.locked_until`. */
export function lockExpiryIso(now: Date, lockMinutes: number = DEFAULT_LOCKOUT.lockMinutes): string {
  return new Date(now.getTime() + lockMinutes * 60_000).toISOString();
}