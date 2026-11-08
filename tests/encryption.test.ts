import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, openForInspection, openInMemoryDatabase } from "../src/data/connection";
import { migrations } from "../src/data/migrations";
import { runMigrations } from "../src/data/migrator";
import { createBackup, verifyBackupFile } from "../src/data/backup";
import { openEncryptedDatabase, resolveEncryptionKey } from "../src/data/encrypted-connection";
import { createTempWorkspace, seedLegacyV1Database, type TempWorkspace } from "./helpers";

/**
 * Encryption and backup round-trips.
 *
 * These cover the two failures that would silently cost a shop its data:
 *
 *  - a backup taken from an encrypted database has to come out encrypted, and
 *    has to be openable again with the same key;
 *  - a database created before the app had encryption has to be converted
 *    rather than rejected, because rejecting it looks identical to losing it.
 *
 * The encrypted cases run against the unencrypted in-memory schema plus an
 * explicit key, because SQLCipher is a property of the connection rather than
 * the schema. The plaintext-upgrade case needs a real file, since it is a
 * file-level conversion.
 */

/** Key used by the tests. Not a real deployment key. */
const KEY = "dGVzdC1rZXktZm9yLWVuY3J5cHRlZC1kYXRhYmFzZQ==";

let workspace: TempWorkspace;

beforeEach(() => {
  workspace = createTempWorkspace("eyerstock-crypto-");
});

afterEach(() => {
  workspace.cleanup();
});

/** A migrated database with a couple of rows worth losing. */
function seededEncryptedDb(path: string): void {
  const db = openEncryptedDatabase(path, KEY);
  runMigrations(db, migrations);

  const now = "2026-01-01T00:00:00.000Z";
  db.prepare(
    `INSERT INTO parties (code, name, kind, opening_balance, created_at, updated_at)
     VALUES ('C-0001', 'Al Rawi Trading', 'customer', 25000, ?, ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO products (sku, name, quantity_milli, average_cost_fils, created_at, updated_at)
     VALUES ('RO-5STAGE', '5-Stage RO System', 10000, 45000, ?, ?)`,
  ).run(now, now);

  closeDatabase(db);
}

describe("backups of an encrypted database", () => {
  /**
   * The regression this exists for: `db.backup(path)` opens the destination
   * itself with no key, and SQLite refuses to copy between a cipher database
   * and a plain one. Backups failed outright, and had they not, they would have
   * left the shop's ledger readable on disk in the clear.
   */
  it("produces an encrypted backup rather than failing", async () => {
    const dbPath = join(workspace.dir, "shop.db");
    seededEncryptedDb(dbPath);

    const source = openEncryptedDatabase(dbPath, KEY);
    try {
      const backupPath = join(workspace.dir, "backups", "manual.db");
      const result = await createBackup(source, backupPath, KEY);

      expect(result.sizeBytes).toBeGreaterThan(0);
      expect(existsSync(backupPath)).toBe(true);
    } finally {
      closeDatabase(source);
    }
  });

  it("does not leave a plaintext copy of the data on disk", async () => {
    const dbPath = join(workspace.dir, "shop.db");
    seededEncryptedDb(dbPath);

    const source = openEncryptedDatabase(dbPath, KEY);
    const backupPath = join(workspace.dir, "backups", "manual.db");
    try {
      await createBackup(source, backupPath, KEY);
    } finally {
      closeDatabase(source);
    }

    const raw = readFileSync(backupPath);
    // The SQLite header would appear verbatim in an unencrypted file.
    expect(raw.subarray(0, 15).toString("utf8")).not.toBe("SQLite format 3");
    // And the customer name must not be readable in the clear either.
    expect(raw.includes(Buffer.from("Al Rawi Trading", "utf8"))).toBe(false);
  });

  it("round-trips: the backup opens with the key and holds the same rows", async () => {
    const dbPath = join(workspace.dir, "shop.db");
    seededEncryptedDb(dbPath);

    const source = openEncryptedDatabase(dbPath, KEY);
    const backupPath = join(workspace.dir, "backups", "manual.db");
    try {
      await createBackup(source, backupPath, KEY);
    } finally {
      closeDatabase(source);
    }

    const verification = verifyBackupFile(backupPath, KEY);
    expect(verification.ok).toBe(true);
    expect(verification.schemaVersion).toBe(Math.max(...migrations.map((m) => m.version)));

    const restored = openForInspection(backupPath, KEY, true, true);
    try {
      const party = restored
        .prepare("SELECT name FROM parties WHERE code = 'C-0001'")
        .get() as { name: string } | undefined;
      expect(party?.name).toBe("Al Rawi Trading");
    } finally {
      closeDatabase(restored);
    }
  });

  it("replaces an existing backup instead of merging into it", async () => {
    const dbPath = join(workspace.dir, "shop.db");
    seededEncryptedDb(dbPath);

    const source = openEncryptedDatabase(dbPath, KEY);
    const backupPath = join(workspace.dir, "backups", "repeat.db");
    try {
      const first = await createBackup(source, backupPath, KEY);
      const second = await createBackup(source, backupPath, KEY);
      expect(second.sizeBytes).toBe(first.sizeBytes);
    } finally {
      closeDatabase(source);
    }
  });

  it("still backs up an unencrypted database the ordinary way", async () => {
    const db = openInMemoryDatabase();
    runMigrations(db, migrations);

    // An in-memory database has no path, so verify the export path instead by
    // round-tripping an unencrypted file through the same code.
    const plainPath = join(workspace.dir, "plain.db");
    const plain = openForInspection(plainPath, null, false, false);
    runMigrations(plain, migrations);

    try {
      const result = await createBackup(plain, join(workspace.dir, "plain-backup.db"), null);
      expect(result.sizeBytes).toBeGreaterThan(0);

      const verification = verifyBackupFile(join(workspace.dir, "plain-backup.db"), null);
      expect(verification.ok).toBe(true);
    } finally {
      closeDatabase(plain);
    }
    closeDatabase(db);
  });
});

describe("upgrading a database created before encryption", () => {
  /**
   * A 0.1.0 installation has an unencrypted file. Applying a key to it makes it
   * unreadable, so without a conversion path an ordinary upgrade would present
   * as total data loss. The original file is kept beside the new one.
   */
  it("converts a plaintext database and keeps every row", () => {
    const dbPath = join(workspace.dir, "legacy.db");

    const plain = openForInspection(dbPath, null, false, false);
    seedLegacyV1Database(plain);
    runMigrations(plain, migrations);
    closeDatabase(plain);

    const upgraded = openEncryptedDatabase(dbPath, KEY);
    try {
      const party = upgraded
        .prepare("SELECT name, opening_balance FROM parties WHERE code = 'C-0001'")
        .get() as { name: string; opening_balance: number } | undefined;

      expect(party?.name).toBe("Al Rawi Trading");
      expect(party?.opening_balance).toBe(25_000);

      const product = upgraded
        .prepare("SELECT name, quantity_milli FROM products WHERE sku = 'RO-5STAGE'")
        .get() as { name: string; quantity_milli: number } | undefined;

      expect(product?.name).toBe("5-Stage RO System");
      expect(product?.quantity_milli).toBe(10_000);

      // And the whole schema arrived, not just the tables that existed in v1.
      const schema = upgraded
        .prepare(
          `SELECT COUNT(*) AS n FROM sqlite_master
            WHERE type = 'table' AND name = 'expenses'`,
        )
        .get() as { n: number };
      expect(schema.n).toBe(1);
    } finally {
      closeDatabase(upgraded);
    }
  });

  it("leaves the original plaintext file alongside for recovery", () => {
    const dbPath = join(workspace.dir, "legacy.db");

    const plain = openForInspection(dbPath, null, false, false);
    seedLegacyV1Database(plain);
    closeDatabase(plain);

    const upgraded = openEncryptedDatabase(dbPath, KEY);
    closeDatabase(upgraded);

    const safety = `${dbPath}.plaintext-backup`;
    expect(existsSync(safety)).toBe(true);

    // The safety copy really is the old, readable database.
    const recovered = openForInspection(safety, null, true, true);
    try {
      const party = recovered
        .prepare("SELECT name FROM parties WHERE code = 'C-0001'")
        .get() as { name: string } | undefined;
      expect(party?.name).toBe("Al Rawi Trading");
    } finally {
      closeDatabase(recovered);
    }
  });

  it("leaves the converted database encrypted and readable with the key", () => {
    const dbPath = join(workspace.dir, "legacy.db");

    const plain = openForInspection(dbPath, null, false, false);
    seedLegacyV1Database(plain);
    closeDatabase(plain);

    const upgraded = openEncryptedDatabase(dbPath, KEY);
    closeDatabase(upgraded);

    const raw = readFileSync(dbPath);
    expect(raw.subarray(0, 15).toString("utf8")).not.toBe("SQLite format 3");
    expect(raw.includes(Buffer.from("Al Rawi Trading", "utf8"))).toBe(false);
  });

  it("does nothing to a database that is already encrypted", () => {
    const dbPath = join(workspace.dir, "already.db");
    seededEncryptedDb(dbPath);

    const reopened = openEncryptedDatabase(dbPath, KEY);
    try {
      const party = reopened
        .prepare("SELECT name FROM parties WHERE code = 'C-0001'")
        .get() as { name: string } | undefined;
      expect(party?.name).toBe("Al Rawi Trading");
      expect(existsSync(`${dbPath}.plaintext-backup`)).toBe(false);
    } finally {
      closeDatabase(reopened);
    }
  });

  it("still refuses when the key is genuinely wrong", () => {
    const dbPath = join(workspace.dir, "shop.db");
    seededEncryptedDb(dbPath);

    // A different key cannot read an encrypted file, and an encrypted file
    // cannot be read as plaintext either, so this must surface as an error
    // rather than being "fixed" by a destructive conversion.
    expect(() => openEncryptedDatabase(dbPath, `${KEY}-not-the-key`)).toThrow(
      /could not be opened/i,
    );
  });
});

describe("encryption key resolution", () => {
  it("writes a key file on first use and reuses it afterwards", () => {
    const first = resolveEncryptionKey(workspace.dir);
    expect(existsSync(first.state.keyFilePath)).toBe(true);

    const second = resolveEncryptionKey(workspace.dir);
    expect(second.key).toBe(first.key);
  });
});
