import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOCKOUT,
  DEFAULT_PASSWORD_POLICY,
  checkPasswordPolicy,
  evaluateLockout,
  hashPassword,
  lockExpiryIso,
  verifyPassword,
} from "../src/domain/auth";

describe("password hashing", () => {
  it("produces a 128-hex-char hash and a 32-hex-char salt", () => {
    const { hash, salt } = hashPassword("Water#2026");
    expect(hash).toMatch(/^[0-9a-f]{128}$/);
    expect(salt).toMatch(/^[0-9a-f]{32}$/);
  });

  it("uses a fresh salt each time, so two users with the same password differ", () => {
    const a = hashPassword("Water#2026");
    const b = hashPassword("Water#2026");
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
  });

  it("verifies the correct password", () => {
    const stored = hashPassword("Water#2026");
    expect(verifyPassword("Water#2026", stored)).toBe(true);
  });

  it("rejects an incorrect password", () => {
    const stored = hashPassword("Water#2026");
    expect(verifyPassword("Water#2027", stored)).toBe(false);
  });

  it("rejects a near-miss of the same length", () => {
    const stored = hashPassword("Water#2026");
    expect(verifyPassword("water#2026", stored)).toBe(false);
  });

  it("is deterministic for a given salt", () => {
    const a = hashPassword("Water#2026", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const b = hashPassword("Water#2026", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(a.hash).toBe(b.hash);
  });

  it("rejects malformed stored hashes instead of throwing", () => {
    expect(verifyPassword("Water#2026", { hash: "short", salt: "alsoshort" })).toBe(false);
    expect(
      verifyPassword("Water#2026", { hash: "z".repeat(128), salt: "a".repeat(32) }),
    ).toBe(false);
  });
});

describe("password policy", () => {
  it("defaults to 8 characters with upper, lower and digit", () => {
    expect(DEFAULT_PASSWORD_POLICY.minLength).toBe(8);
    expect(DEFAULT_PASSWORD_POLICY.requireSymbol).toBe(false);
  });

  it("accepts a compliant password", () => {
    expect(checkPasswordPolicy("Water123")).toEqual({ ok: true });
  });

  it("rejects a short password and names the rule", () => {
    const result = checkPasswordPolicy("Wat1");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/at least 8/);
  });

  it("requires a capital letter", () => {
    const result = checkPasswordPolicy("water123");
    expect(result.ok === false && result.reason).toMatch(/capital letter/);
  });

  it("requires a small letter", () => {
    const result = checkPasswordPolicy("WATER123");
    expect(result.ok === false && result.reason).toMatch(/small letter/);
  });

  it("requires a number", () => {
    const result = checkPasswordPolicy("WaterPure");
    expect(result.ok === false && result.reason).toMatch(/number/);
  });

  it("requires a symbol only when the policy asks for one", () => {
    expect(checkPasswordPolicy("Water123", { ...DEFAULT_PASSWORD_POLICY, requireSymbol: true }).ok).toBe(
      false,
    );
    expect(
      checkPasswordPolicy("Water#123", { ...DEFAULT_PASSWORD_POLICY, requireSymbol: true }).ok,
    ).toBe(true);
  });

  it("honours a raised minimum length", () => {
    expect(checkPasswordPolicy("Water123", { ...DEFAULT_PASSWORD_POLICY, minLength: 12 }).ok).toBe(
      false,
    );
  });
});

describe("login lockout", () => {
  const now = new Date("2026-03-01T10:00:00.000Z");

  it("defaults to 5 attempts and 15 minutes", () => {
    expect(DEFAULT_LOCKOUT.threshold).toBe(5);
    expect(DEFAULT_LOCKOUT.lockMinutes).toBe(15);
  });

  it("allows attempts while far from the threshold", () => {
    const decision = evaluateLockout(1, null, now);
    expect(decision.locked).toBe(false);
    expect(decision.remainingAttempts).toBe(4);
    expect(decision.message).toBeNull();
  });

  it("warns on the last two remaining attempts", () => {
    expect(evaluateLockout(3, null, now).message).toMatch(/2 left/);
    expect(evaluateLockout(4, null, now).message).toMatch(/1 left/);
  });

  it("locks once the threshold is reached", () => {
    const decision = evaluateLockout(5, lockExpiryIso(now), now);
    expect(decision.locked).toBe(true);
    expect(decision.remainingAttempts).toBe(0);
    expect(decision.message).toMatch(/Too many wrong attempts/);
  });

  it("counts whole minutes remaining, rounded up", () => {
    const until = new Date(now.getTime() + 90_000).toISOString();
    const decision = evaluateLockout(5, until, now);
    expect(decision.message).toMatch(/2 minute\(s\)/);
  });

  it("never reports zero minutes remaining", () => {
    const until = new Date(now.getTime() + 1_000).toISOString();
    expect(evaluateLockout(5, until, now).message).toMatch(/1 minute\(s\)/);
  });

  it("releases the account once the expiry has passed", () => {
    const until = new Date(now.getTime() - 1_000).toISOString();
    const decision = evaluateLockout(5, until, now);
    expect(decision.locked).toBe(false);
    expect(decision.untilIso).toBeNull();
    expect(decision.remainingAttempts).toBe(0);
  });

  it("ignores an unparsable expiry rather than locking forever", () => {
    const decision = evaluateLockout(2, "not-a-date", now);
    expect(decision.locked).toBe(false);
    expect(decision.remainingAttempts).toBe(3);
  });

  it("never returns a negative remaining-attempt count", () => {
    expect(evaluateLockout(99, null, now).remainingAttempts).toBe(0);
  });

  it("builds the expiry from the configured duration", () => {
    expect(lockExpiryIso(now, 15)).toBe("2026-03-01T10:15:00.000Z");
    expect(lockExpiryIso(now, 30)).toBe("2026-03-01T10:30:00.000Z");
  });
});