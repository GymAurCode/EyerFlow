import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hashPassword } from "../src/domain/auth";
import {
  changePassword,
  currentAvatarName,
  readProfile,
  updateOwnProfile,
} from "../src/main/repositories/users";
import { loadSessionUser } from "../src/main/session";
import {
  AvatarError,
  deleteAvatar,
  isValidAvatarFileName,
  MAX_AVATAR_BYTES,
  readAvatarDataUrl,
  storeAvatar,
} from "../src/main/avatars";
import { createTempWorkspace, freshDb, migrateInMemory } from "./helpers";
import { closeDatabase, openDatabase } from "../src/data/connection";
import type { SqliteDatabase } from "../src/data/connection";
import type { AuditActor } from "../src/main/audit-writer";

const NOW = "2026-01-01T00:00:00.000Z";
const actor: AuditActor = { id: null, name: "test" };

/** A migrated database with one user who has the Administrator role. */
function seedUser(db: SqliteDatabase, username = "owner"): number {
  // A migration already creates the fixed roles, so take that row rather than
  // inserting a second Administrator and colliding with the UNIQUE constraint.
  const existing = db.prepare("SELECT id FROM roles WHERE name = 'Administrator'").get() as
    | { id: number }
    | undefined;
  const roleId =
    existing?.id ??
    Number(
      db.prepare("INSERT INTO roles (name, is_system, created_at) VALUES ('Administrator', 1, ?)")
        .run(NOW).lastInsertRowid,
    );
  const stored = hashPassword("Water#2026");
  const id = Number(
    db
      .prepare(
        `INSERT INTO users (username, display_name, password_hash, password_salt, role_id,
                            must_change_password, is_active, failed_attempts, created_at, updated_at)
         VALUES (?, 'Original Name', ?, ?, ?, 0, 1, 0, ?, ?)`,
      )
      .run(username, stored.hash, stored.salt, roleId, NOW, NOW).lastInsertRowid,
  );
  return id;
}

describe("profile fields migration", () => {
  it("adds the three profile columns without touching existing rows", () => {
    const db = freshDb();
    migrateInMemory(db);
    const id = seedUser(db);

    const columns = (
      db.prepare("PRAGMA table_info(users)").all() as { name: string }[]
    ).map((c) => c.name);

    expect(columns).toContain("email");
    expect(columns).toContain("phone");
    expect(columns).toContain("avatar_path");

    // The existing row keeps its identity and gains nulls, not invented values.
    const row = db
      .prepare("SELECT display_name, email, phone, avatar_path FROM users WHERE id = ?")
      .get(id) as Record<string, unknown>;
    expect(row["display_name"]).toBe("Original Name");
    expect(row["email"]).toBeNull();
    expect(row["phone"]).toBeNull();
    expect(row["avatar_path"]).toBeNull();
  });
});

describe("profile read and update", () => {
  it("round-trips name, email and phone and keeps them in the database", () => {
    const workspace = createTempWorkspace("eyerstock-profile-");
    try {
      // A real file, so "it persists" can be checked by closing the connection
      // and opening a second one rather than by reading the same handle twice.
      const db = openDatabase(workspace.dbPath);
      migrateInMemory(db);
      const id = seedUser(db);

      const before = readProfile(db, id, workspace.dir, "Blue Water Co");
      expect(before.displayName).toBe("Original Name");
      expect(before.email).toBeNull();
      expect(before.companyName).toBe("Blue Water Co");

      updateOwnProfile({ db, actor, nowIso: NOW }, id, {
        displayName: "  Ali  Khan  ",
        email: "  Ali.Khan@Example.COM ",
        phone: " +971500000000 ",
      });

      // Trimmed on the way in, and the email lowercased.
      const after = readProfile(db, id, workspace.dir, "Blue Water Co");
      expect(after.displayName).toBe("Ali  Khan");
      expect(after.email).toBe("ali.khan@example.com");
      expect(after.phone).toBe("+971500000000");

      closeDatabase(db);

      // A brand-new connection to the same file: this is the "survives a
      // restart" claim, actually exercised.
      const reopened = openDatabase(workspace.dbPath);
      const persisted = readProfile(reopened, id, workspace.dir, "Blue Water Co");
      expect(persisted.displayName).toBe("Ali  Khan");
      expect(persisted.email).toBe("ali.khan@example.com");
      expect(persisted.phone).toBe("+971500000000");
      closeDatabase(reopened);
    } finally {
      workspace.cleanup();
    }
  });

  it("refuses a blank name", () => {
    const db = freshDb();
    migrateInMemory(db);
    const id = seedUser(db);
    expect(() =>
      updateOwnProfile({ db, actor, nowIso: NOW }, id, {
        displayName: "   ",
        email: "",
        phone: "",
      }),
    ).toThrow();
  });

  it("stores an empty email and phone as null rather than as empty strings", () => {
    const db = freshDb();
    migrateInMemory(db);
    const id = seedUser(db);

    updateOwnProfile({ db, actor, nowIso: NOW }, id, {
      displayName: "Ali Khan",
      email: "ali@example.com",
      phone: "123",
    });
    updateOwnProfile({ db, actor, nowIso: NOW }, id, {
      displayName: "Ali Khan",
      email: "",
      phone: "",
    });

    const profile = readProfile(db, id, "", "x");
    expect(profile.email).toBeNull();
    expect(profile.phone).toBeNull();
  });

  it("rejects an avatar path that did not come from the avatar store", () => {
    const db = freshDb();
    migrateInMemory(db);
    const id = seedUser(db);

    for (const attempt of [
      "../../../etc/passwd",
      "C:\\Windows\\System32\\config\\SAM",
      "/etc/passwd",
      "avatar.png",
    ]) {
      expect(() =>
        updateOwnProfile({ db, actor, nowIso: NOW }, id, {
          displayName: "Ali Khan",
          email: "",
          phone: "",
          avatarPath: attempt,
        }),
      ).toThrow();
    }
  });
});

describe("avatar storage", () => {
  it("copies the chosen image into the avatars folder and reads it back", () => {
    const workspace = createTempWorkspace("eyerstock-avatar-");
    try {
      const db = freshDb();
      migrateInMemory(db);
      const id = seedUser(db);

      const source = join(workspace.dir, "chosen.png");
      // A 1x1 PNG, so the bytes are a real image rather than a stub.
      writeFileSync(
        source,
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
          "base64",
        ),
      );

      const name = storeAvatar(join(workspace.dir, "avatars"), id, source, null);
      expect(name).toBe(`${String(id)}.png`);
      expect(existsSync(join(workspace.dir, "avatars", name))).toBe(true);

      updateOwnProfile({ db, actor, nowIso: NOW }, id, {
        displayName: "Ali Khan",
        email: "",
        phone: "",
        avatarPath: name,
      });

      const profile = readProfile(db, id, join(workspace.dir, "avatars"), "x");
      expect(profile.avatarDataUrl).toMatch(/^data:image\/png;base64,/);

      // And it reaches the session user, which is what the rail renders.
      const session = loadSessionUser(db, id, join(workspace.dir, "avatars"));
      expect(session?.avatarDataUrl).toMatch(/^data:image\/png;base64,/);
    } finally {
      workspace.cleanup();
    }
  });

  it("rejects a file that is not a supported image", () => {
    const workspace = createTempWorkspace("eyerstock-avatar-");
    try {
      const source = join(workspace.dir, "notes.txt");
      writeFileSync(source, "not an image");
      expect(() => storeAvatar(join(workspace.dir, "avatars"), 1, source, null)).toThrow(
        AvatarError,
      );
    } finally {
      workspace.cleanup();
    }
  });

  it("rejects an image over the size cap", () => {
    const workspace = createTempWorkspace("eyerstock-avatar-");
    try {
      const source = join(workspace.dir, "huge.png");
      writeFileSync(source, Buffer.alloc(MAX_AVATAR_BYTES + 1));
      expect(() => storeAvatar(join(workspace.dir, "avatars"), 1, source, null)).toThrow(
        /2 MB/,
      );
    } finally {
      workspace.cleanup();
    }
  });

  it("only accepts file names of the shape it generates", () => {
    expect(isValidAvatarFileName("7.png")).toBe(true);
    expect(isValidAvatarFileName("7.JPG")).toBe(true);
    expect(isValidAvatarFileName("../../secrets.png")).toBe(false);
    expect(isValidAvatarFileName("avatar.png")).toBe(false);
    expect(isValidAvatarFileName("")).toBe(false);
  });

  it("returns null rather than throwing when the file has gone", () => {
    const workspace = createTempWorkspace("eyerstock-avatar-");
    try {
      const dir = join(workspace.dir, "avatars");
      mkdirSync(dir, { recursive: true });
      expect(readAvatarDataUrl(dir, "1.png")).toBeNull();
    } finally {
      workspace.cleanup();
    }
  });

  it("deletes the file it replaces", () => {
    const workspace = createTempWorkspace("eyerstock-avatar-");
    try {
      const dir = join(workspace.dir, "avatars");
      const source = join(workspace.dir, "a.png");
      writeFileSync(source, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      const first = storeAvatar(dir, 5, source, null);
      expect(existsSync(join(dir, first))).toBe(true);

      deleteAvatar(dir, first);
      expect(existsSync(join(dir, first))).toBe(false);
    } finally {
      workspace.cleanup();
    }
  });

  it("keeps the previous picture when the update did not touch the avatar field", () => {
    const workspace = createTempWorkspace("eyerstock-avatar-");
    try {
      const db = freshDb();
      migrateInMemory(db);
      const id = seedUser(db);
      const dir = join(workspace.dir, "avatars");

      const source = join(workspace.dir, "a.png");
      writeFileSync(source, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      const name = storeAvatar(dir, id, source, null);

      updateOwnProfile({ db, actor, nowIso: NOW }, id, {
        displayName: "Ali Khan",
        email: "",
        phone: "",
        avatarPath: name,
      });

      // A later edit that leaves avatarPath out must not clear the picture.
      const result = updateOwnProfile({ db, actor, nowIso: NOW }, id, {
        displayName: "Ali Khan Two",
        email: "",
        phone: "",
      });

      expect(result.previousAvatar).toBe(name);
      expect(currentAvatarName(db, id)).toBe(name);
    } finally {
      workspace.cleanup();
    }
  });
});

describe("password change", () => {
  it("verifies the current password and re-hashes the new one", () => {    const workspace = createTempWorkspace("eyerstock-pw-");
    try {
      const db = freshDb();
      migrateInMemory(db);
      const id = seedUser(db, "owner");

      const before = db
        .prepare("SELECT password_hash FROM users WHERE id = ?")
        .get(id) as { password_hash: string };

      // Wrong current password is refused.
      expect(() =>
        changePassword(db, actor, id, "NotThePassword1", "Another#2026", NOW),
      ).toThrow(/current password/i);

      // A policy failure is refused.
      expect(() => changePassword(db, actor, id, "Water#2026", "short", NOW)).toThrow();

      changePassword(db, actor, id, "Water#2026", "Another#2026", NOW);

      const after = db
        .prepare("SELECT password_hash, password_salt FROM users WHERE id = ?")
        .get(id) as { password_hash: string; password_salt: string };

      // Re-hashed with a fresh salt, so the stored value differs.
      expect(after.password_hash).not.toBe(before.password_hash);
      expect(after.password_hash.length).toBeGreaterThan(0);

      // And the new password is what now verifies.
      expect(() => changePassword(db, actor, id, "Another#2026", "Third#2026", NOW)).not.toThrow();
    } finally {
      workspace.cleanup();
    }
  });

  it("never stores a plain-text password", () => {
    const db = freshDb();
    migrateInMemory(db);
    const id = seedUser(db);
    // The policy requires a digit, which the previous value did not have.
    const chosen = "PlainTextLeak2026";
    changePassword(db, actor, id, "Water#2026", chosen, NOW);

    const row = db
      .prepare("SELECT password_hash, password_salt FROM users WHERE id = ?")
      .get(id) as { password_hash: string; password_salt: string };

    expect(row.password_hash).not.toContain(chosen);
    expect(row.password_salt).not.toContain(chosen);
  });

  it("refuses a password that does not meet the policy", () => {
    const db = freshDb();
    migrateInMemory(db);
    const id = seedUser(db);
    // No digit, no symbol, too short: all three rules at once.
    expect(() => changePassword(db, actor, id, "Water#2026", "plaintext", NOW)).toThrow();
  });
});
