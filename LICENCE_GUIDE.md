# License Key Generation Guide

This guide explains how to generate license keys for customers using the offline licensing system.

## Overview

EyerStock uses machine-locked offline licenses based on Ed25519 signatures. The system works entirely offline - no internet connection is required for activation or verification.

### Key Concepts

- **Machine ID**: A stable hardware-based identifier generated from system components (MachineGuid + CPU + Disk serial on Windows)
- **License Key**: Base64url-encoded JSON payload + Ed25519 signature
- **Public Key**: Embedded in the app (generated once, never changes)
- **Private Key**: Stored securely in `tools/keygen/private.key` - **NEVER COMMIT THIS**

## Initial Setup (Run Once)

```bash
npm run keygen:init
```

This generates:

- `tools/keygen/private.key` - Ed25519 private key (PEM format) - **KEEP SECURE**
- `src/main/license-public-key.ts` - Public key constant embedded in the app

**⚠️ Critical**: Add `tools/keygen/private.key` to `.gitignore` and store it securely (password manager, encrypted USB, HSM). If compromised, anyone can generate valid licenses.

### `keygen:init` refuses to replace an existing keypair

If `private.key` already exists, `keygen:init` stops and explains why instead of
overwriting. Replacing the private key invalidates **every** licence ever issued
with it, and customers who have already activated are locked out on their next
launch.

```bash
npm run keygen:init            # refuses if private.key exists
npm run keygen:init -- --force # replaces it; back it up first
```

### Check the two halves still agree

The keypair is two files, and they drift apart when one is replaced without the
other - a stale `license-public-key.ts` picked up by a build, or one file copied
on its own. Every key signed from that point is correctly signed and useless:
the app holds a different public key and rejects it.

```bash
npm run keygen:check   # compares private.key against the embedded public key
```

If they do not match, repair it with `npm run keygen:init -- --force` (which
rewrites the public key constant from the private key you already have, without
discarding the private key), then **rebuild the app** so the new public key is
compiled in. `npm run keygen` refuses to issue a key while they disagree.

## Generating a License Key for a Customer

### 1. Get the Customer's Machine ID

Ask the customer to:

1. Install and run EyerStock
2. The Activate screen will show their Machine ID with a Copy button
3. Send you the Machine ID

### 2. Generate the License Key

```bash
# Perpetual license (no expiry)
npm run keygen -- --machine "abc123..." --client "Acme Water Purification"

# License expiring on a specific date
npm run keygen -- --machine "abc123..." --client "Acme Water Purification" --expires 2027-12-31

# Different edition
npm run keygen -- --machine "abc123..." --client "Acme Water Purification" --edition pro
```

Every key is verified through the same code the app uses before it is printed,
so a key that reaches you is a key that activates.

### 3. Verify the Key Before Sending It

```bash
npm run keygen:verify -- --key "eyJtYWNoaW5lSWQiOi..." --machine "abc123..."
```

Each check is reported separately - format, signature, machineId, expiry - so
there is no guessing which one failed:

```
[PASS] format     two base64 segments separated by a dot, payload is JSON
[PASS] signature  signature matches the public key embedded in the app
[PASS] machineId  key is bound to the given machine
[PASS] expiry     valid for 447 more day(s)

VALID
```

Leave off `--machine` to check everything except the computer binding.

### 4. Send the License Key to the Customer

Copy the entire key (the long string starting with `eyJ...`) and send it securely to the customer. They paste it into the Activate screen and click Activate.

Pasting is forgiving: surrounding whitespace, a line break in the middle, and
wrapping quotes are all removed before the key is checked.

## If a Customer Changes Hardware

When a customer replaces their PC or major hardware components:

1. They install EyerStock on the new machine
2. The Activate screen shows a **new** Machine ID
3. They send you the new Machine ID
4. You generate a new license key with the new Machine ID
5. The old key becomes invalid (it's tied to the old Machine ID)

**No data is lost** - the license only controls app access, not the database.

## Security Best Practices

1. **Private Key Protection**
   - Store `private.key` in a password manager or encrypted storage
   - Never commit to git (already in .gitignore)
   - Run `npm run keygen:check` after any move or restore of either key file
   - Rotate annually: `npm run keygen:init -- --force`, then **rebuild the app**
     and issue new keys to every customer

2. **Key Distribution**
   - Send license keys via encrypted email or secure messaging
   - Never post keys in public channels

3. **Expiry Management**
   - Set reasonable expiry dates for subscription licenses
   - Monitor expiring licenses (14-day warning appears in app)
   - Generate renewal keys before expiry

4. **Compromise Response**
   If private key is compromised:
   - Immediately run `npm run keygen:init -- --force` to generate a new keypair
   - Rebuild and redistribute the app (`npm run dist`)
   - All existing licenses become invalid - issue new keys to all customers

## Technical Details

### License Key Format

```
base64url(payload).base64url(signature)
```

### Which Bytes Are Signed

The signature covers the **canonical base64url encoding of the payload bytes** -
decoded once and re-encoded to unpadded base64url, and those exact characters
are what `crypto.sign(null, ...)` is given and what `crypto.verify(null, ...)`
is checked against.

Canonical rather than literal is the point. A key that travelled through an
email client, a terminal, or a document can arrive with a leading newline, wrapped
in quotes, or broken across two lines. The payload still decodes - base64
decoding ignores all of that - so the key looks perfectly valid, but checking the
signature over the _literal pasted text_ against bytes that were signed from the
_clean_ text fails. That produced "invalid signature" for keys nobody had touched.
Normalising before signing and before verifying makes all of those pastes
equivalent, while any change to the payload itself still changes the signed bytes
and is still rejected.

Both base64 (`+/`) and base64url (`-_`) are accepted on input; `=` padding is
optional. Ed25519 is signature-only, so the algorithm argument is always `null` -
never `createSign`/`createVerify`, which throw `ERR_CRYPTO_INVALID_DIGEST`.

### Payload Structure

```json
{
  "machineId": "sha256-hash-of-hardware-identifiers",
  "clientName": "Customer Name",
  "issuedAt": "2026-10-10T10:00:00.000Z",
  "expiresAt": "2027-12-31T23:59:59.999Z", // null for perpetual
  "edition": "standard"
}
```

### Verification Process (In App)

1. Normalise the key: strip whitespace, wrapping quotes, and any internal line breaks
2. Split into payload and signature segments
3. Decode the payload and re-encode it canonically
4. Verify the Ed25519 signature over those canonical bytes
5. Check `payload.machineId` matches the current machine's ID
6. Check `payload.expiresAt` is not in the past (if set)
7. Check for clock rollback (stored last-seen timestamp)

### Files

- `src/main/license-verify.ts` - **The key format.** Signing and verification. Imported by both the app and the key generator so the two cannot drift apart. Shipped unobfuscated.
- `tools/keygen/license-key.ts` - Key generation and checking logic
- `tools/keygen/index.ts` - CLI front end for the `npm run keygen*` commands
- `tools/keygen/private.key` - Private key (KEEP SECURE)
- `src/main/license-public-key.ts` - Public key (embedded in app)
- `src/main/license.ts` - Verification, storage, and periodic re-checks
- `src/main/machine-id.ts` - Machine ID generation

## Troubleshooting

Start with `npm run keygen:verify -- --key "<the key>"`. It names the check that
failed, and needs no install.

### "Invalid key format"

- Text that is not two base64 segments separated by a dot
- A key truncated in transit, or copied only halfway

### "Signature does not match (wrong keypair or edited key)"

- The key was edited, or the signature belongs to different payload bytes
- `tools/keygen/private.key` no longer matches the public key embedded in the app - run `npm run keygen:check`
- The app was built before the current public key was written - rebuild and reinstall

### "This key is for a different computer"

- Customer sent the wrong Machine ID
- Hardware changed since the key was generated
- Generate a new key with the correct Machine ID

### "Key expired"

- The expiry date has passed
- Generate a renewal key with a new expiry date

### "This computer's ID could not be read"

- The hardware reader could not run. Restart the app; if it persists, the main
  process cannot read this PC's machine identifiers.

### "The licence could not be saved on this computer"

- The app's data folder is not writable, or is full

### "System clock appears to have been rolled back"

- Customer changed the system clock backwards significantly
- App requires re-activation to prevent license abuse
