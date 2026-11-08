import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The database key file.
 *
 * It has two legitimate on-disk forms - DPAPI ciphertext and plain text - and
 * which one is correct depends on whether the Windows key store was reachable
 * when the file was written. A build of this app that started before Electron's
 * `ready` event always saw it as unreachable, so real installations were left
 * with a text key file on machines that would otherwise have written ciphertext.
 *
 * Reading a text key file through `safeStorage.decryptString` throws, and that
 * error used to escape and take the whole app down with it. These tests pin the
 * recovery: the text key must be adopted, the database must still open with it,
 * and the file must be rewritten encrypted.
 */

const KEY_FILE = "db-key.bin";
const KEY_LENGTH = 32;

/** A plausible plaintext key file: base64 of 32 random bytes, as written by us. */
function plaintextKeyFile(): Buffer {
  return Buffer.from(Buffer.alloc(KEY_LENGTH, 7).toString("base64"), "utf8");
}

interface SafeStorageStub {
  readonly isEncryptionAvailable: () => boolean;
  readonly encryptString: (value: string) => Buffer;
  readonly decryptString: (value: Buffer) => string;
  readonly encrypted: Buffer[];
}

let available = true;
let stored: string | null = null;
let decryptCalls = 0;

/** Signature of the function under test, so the mock is typed at its use site. */
type ResolveEncryptionKey = (
  userDataDir: string,
) => { key: string; state: { mode: string; keyFilePath: string; warning: string | null } };

/**
 * Stand in for Electron's safeStorage.
 *
 * `encryptString` prefixes a marker byte the way a real ciphertext would be
 * binary, so a text key file is genuinely not decryptable - which is the
 * condition the recovery has to survive.
 */
const safeStorageStub: SafeStorageStub = {
  isEncryptionAvailable: () => available,
  encryptString: (value: string) => {
    const buffer = Buffer.concat([Buffer.from([0x01, 0x02, 0x03]), Buffer.from(value, "utf8")]);
    safeStorageStub.encrypted.push(buffer);
    return buffer;
  },
  decryptString: (value: Buffer) => {
    decryptCalls += 1;
    if (value[0] !== 0x01) {
      throw new Error("Ciphertext does not appear to be encrypted.");
    }
    return value.subarray(3).toString("utf8");
  },
  encrypted: [],
};

vi.mock("electron", () => ({
  safeStorage: {
    get isEncryptionAvailable() {
      return safeStorageStub.isEncryptionAvailable;
    },
    encryptString: (value: string) => safeStorageStub.encryptString(value),
    decryptString: (value: Buffer) => safeStorageStub.decryptString(value),
  },
}));

let resolveEncryptionKey: ResolveEncryptionKey;

beforeAll(async () => {
  // Imported after the mock is registered: the module reads safeStorage once at
  // call time, so the stub has to be in place first.
  ({ resolveEncryptionKey } = await import("../src/data/encrypted-connection"));
});

let dir: string;

beforeEach(() => {
  available = true;
  stored = null;
  decryptCalls = 0;
  safeStorageStub.encrypted.length = 0;
  dir = mkdtempSync(join(tmpdir(), "minha-key-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("creating the key file", () => {
  it("writes an encrypted key when key protection is available", () => {
    const { key, state } = resolveEncryptionKey(dir);

    expect(state.mode).toBe("safeStorage");
    expect(state.warning).toBeNull();
    expect(Buffer.from(key, "base64")).toHaveLength(KEY_LENGTH);
    expect(safeStorageStub.encrypted).toHaveLength(1);
  });

  it("writes a text key and warns when key protection is unavailable", () => {
    available = false;

    const { state } = resolveEncryptionKey(dir);

    expect(state.mode).toBe("keyFile");
    expect(state.warning).toMatch(/key protection/i);
  });

  it("produces the same key on every call", () => {
    const first = resolveEncryptionKey(dir).key;
    const second = resolveEncryptionKey(dir).key;
    expect(second).toBe(first);
  });
});

describe("reading a key file that is plain text", () => {
  /** The regression: a text key file used to throw and stop the app starting. */
  it("adopts the key instead of failing to decrypt it", () => {
    const text = plaintextKeyFile();
    writeFileSync(join(dir, KEY_FILE), text);

    const { key, state } = resolveEncryptionKey(dir);

    expect(key).toBe(text.toString("utf8"));
    expect(state.mode).toBe("safeStorage");
  });

  it("rewrites the file encrypted so it is protected from then on", () => {
    writeFileSync(join(dir, KEY_FILE), plaintextKeyFile());

    resolveEncryptionKey(dir);

    const rewritten = readFileSync(join(dir, KEY_FILE));
    // No longer readable as text: the key is no longer sitting in the clear.
    expect(rewritten.toString("utf8").trim()).not.toBe(plaintextKeyFile().toString("utf8"));
  });

  it("keeps returning the same key on every later start", () => {
    writeFileSync(join(dir, KEY_FILE), plaintextKeyFile());

    const first = resolveEncryptionKey(dir).key;
    const second = resolveEncryptionKey(dir).key;
    const third = resolveEncryptionKey(dir).key;

    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it("reads a text key without the key store, as it was written", () => {
    available = false;
    const text = plaintextKeyFile();
    writeFileSync(join(dir, KEY_FILE), text);

    const { key, state } = resolveEncryptionKey(dir);

    expect(key).toBe(text.toString("utf8"));
    expect(state.mode).toBe("keyFile");
  });
});

describe("reading a key file that is encrypted", () => {
  it("decrypts it", () => {
    const first = resolveEncryptionKey(dir);
    const second = resolveEncryptionKey(dir);

    expect(second.key).toBe(first.key);
    expect(decryptCalls).toBeGreaterThan(0);
  });

  it("explains itself when the key store is unavailable", () => {
    const first = resolveEncryptionKey(dir);
    expect(first.state.mode).toBe("safeStorage");

    // Key protection gone - a different Windows user, or a restore onto a
    // machine without the original key store.
    available = false;

    expect(() => resolveEncryptionKey(dir)).toThrow(/key store/i);
  });
});

describe("rejecting a damaged key file", () => {
  it("refuses binary junk that is not one of our keys", () => {
    // Corruption must be reported, not reinterpreted as a key: adopting
    // arbitrary bytes would produce a baffling "wrong key" failure later.
    writeFileSync(join(dir, KEY_FILE), Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x02]));

    expect(() => resolveEncryptionKey(dir)).toThrow();
  });

  it("refuses a key file of the wrong length", () => {
    writeFileSync(join(dir, KEY_FILE), Buffer.from("c2hvcnQ=", "utf8"));

    expect(() => resolveEncryptionKey(dir)).toThrow();
  });

  it("leaves a damaged key file in place rather than overwriting it", () => {
    const damaged = Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x02]);
    writeFileSync(join(dir, KEY_FILE), damaged);

    expect(() => resolveEncryptionKey(dir)).toThrow();
    expect(readFileSync(join(dir, KEY_FILE)).equals(damaged)).toBe(true);
  });
});

describe("key file location", () => {
  it("is inside the data folder the app was given", () => {
    const { state } = resolveEncryptionKey(dir);
    expect(state.keyFilePath).toBe(join(dir, KEY_FILE));
    expect(existsSync(state.keyFilePath)).toBe(true);
  });
});

// Referenced so the unused import warning does not fire if the helper changes.
void stored;
