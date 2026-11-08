/**
 * `npm run keygen*` command line front end.
 *
 * All of the logic lives in `license-key.ts`, which has no side effects on
 * import so the test suite can use it. This file only parses arguments and
 * prints.
 *
 * Usage:
 *   npm run keygen:init                 # Generate an Ed25519 keypair
 *   npm run keygen:init -- --force      # Replace an existing keypair
 *   npm run keygen -- --machine <ID> --client "Name" [--expires 2027-12-31]
 *   npm run keygen:verify -- --key <KEY> [--machine <ID>]
 */

import {
  buildLicenseKey,
  PRIVATE_KEY_FILE,
  PUBLIC_KEY_CONSTANT_FILE,
  assertKeypairMatches,
  generateKeypair,
  inspectLicenseKey,
  verifyLicenseCommand,
} from "./license-key";

function printUsage(): void {
  console.log(`
License Key Generator
====================

Commands:
  npm run keygen:init                            Generate an Ed25519 keypair
  npm run keygen:init -- --force                 Replace an existing keypair
  npm run keygen -- --machine <ID> --client "N"  Issue a license key
  npm run keygen:verify -- --key <KEY>           Verify a key the way the app does
  npm run keygen:inspect -- --key <KEY>          Show a key's payload
  npm run keygen:check                           Check the keypair still matches

Options for keygen:
  --machine <ID>           Machine ID (required)
  --client <Name>          Client name (required)
  --expires <YYYY-MM-DD>   Expiry date (optional, default: perpetual)
  --edition <name>         Edition name (optional, default: standard)

Options for keygen:verify:
  --key <KEY>              The key to check (required, or set EYERSTOCK_LICENSE_KEY)
  --machine <ID>           Also check the key is bound to this machine

Examples:
  npm run keygen:init
  npm run keygen -- --machine "abc123..." --client "Acme Corp" --expires 2027-12-31
  npm run keygen:verify -- --key "eyJtYWNoaW5lSWQiOi....signature"
`);
}

/** Parse `--flag value` and bare `--flag` pairs. A flag followed by a flag is bare. */
function parseArgs(args: readonly string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined || !arg.startsWith("--")) continue;

    const next = args[i + 1];
    const value = next === undefined || next.startsWith("--") ? "" : next;
    if (value !== "") i++;
    parsed.set(arg.slice(2), value);
  }
  return parsed;
}

function commandInit(flags: ReadonlyMap<string, string>): void {
  const force = flags.has("force");
  const result = generateKeypair({ force });

  if (!result.created) {
    console.error(`  ${result.reason ?? "A private key already exists."}`);
    console.error("");
    console.error("  Replacing it invalidates EVERY licence key ever issued with it:");
    console.error("  customers who have already activated are locked out on next launch.");
    console.error("");
    console.error("  If you only need to repair a mismatch between the two key files, use");
    console.error("  `npm run keygen:check` to see the problem, then --force to rewrite the");
    console.error("  public key constant from the private key you already have.");
    console.error("");
    console.error("  Back the existing private.key up before continuing:");
    console.error(`    ${PRIVATE_KEY_FILE}`);
    console.error("");
    process.exit(1);
  }

  console.log("  Keypair generated.");
  console.log(`  Private key         : ${PRIVATE_KEY_FILE}`);
  console.log(`  Embedded public key : ${PUBLIC_KEY_CONSTANT_FILE}`);
  console.log("");
  console.log("  Rebuild the app before issuing keys. The public key constant is compiled");
  console.log("  into the main process, so a build made before this point still holds the");
  console.log("  previous key and will reject every key signed from now on.");
  console.log("");
  console.log("  Keep private.key out of version control and back it up separately.");
}

function commandVerify(flags: ReadonlyMap<string, string>): number {
  const key = flags.get("key") ?? process.env["EYERSTOCK_LICENSE_KEY"] ?? "";
  if (key === "") {
    console.error("Error: --key is required");
    printUsage();
    return 1;
  }

  const result = verifyLicenseCommand({ key, machine: flags.get("machine") });

  console.log("  Checking against the public key embedded in the app:");
  console.log("");
  for (const check of result.checks) {
    console.log(`  [${check.passed ? "PASS" : "FAIL"}] ${check.name.padEnd(10)} ${check.detail}`);
  }
  console.log("");

  if (result.payload !== null) {
    console.log("  Payload:");
    console.log(`    machineId  : ${result.payload.machineId}`);
    console.log(`    clientName : ${result.payload.clientName}`);
    console.log(`    issuedAt   : ${result.payload.issuedAt}`);
    console.log(`    expiresAt  : ${result.payload.expiresAt ?? "(perpetual)"}`);
    console.log(`    edition    : ${result.payload.edition}`);
    console.log("");
  }

  if (result.ok) {
    console.log("  VALID");
    return 0;
  }

  console.log(`  INVALID - failed "${result.stage}": ${result.message}`);
  return 1;
}

function commandInspect(flags: ReadonlyMap<string, string>): number {
  const key = flags.get("key") ?? process.env["EYERSTOCK_LICENSE_KEY"] ?? "";
  if (key === "") {
    console.error("Error: --key is required");
    return 1;
  }

  try {
    console.log(JSON.stringify(inspectLicenseKey(key), null, 2));
    return 0;
  } catch (error) {
    console.error("Invalid key format:", error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function commandCheck(): number {
  try {
    assertKeypairMatches();
  } catch (error) {
    console.error("Error:", error instanceof Error ? error.message : String(error));
    return 1;
  }
  console.log("  Keypair OK: private.key matches the public key embedded in the app.");
  return 0;
}

function commandGenerate(flags: ReadonlyMap<string, string>): number {
  const machine = flags.get("machine") ?? "";
  const client = flags.get("client") ?? "";
  if (machine === "" || client === "") {
    console.error("Error: --machine and --client are required");
    printUsage();
    return 1;
  }

  const key = buildLicenseKey({
    machine,
    client,
    expires: flags.get("expires"),
    edition: flags.get("edition"),
  });

  // Printed on a line of its own. Whitespace around a pasted key is normalised
  // away before verification, but a key that is clean in the terminal is one
  // less thing for the customer to get wrong.
  console.log("");
  console.log("=== LICENSE KEY ===");
  console.log(key);
  console.log("===================");
  console.log("");
  console.log("Payload:");
  console.log(JSON.stringify(inspectLicenseKey(key), null, 2));
  console.log("");
  console.log("Verify it any time with:");
  console.log(`  npm run keygen:verify -- --key "${key}"`);

  return 0;
}

function main(): void {
  const argv = process.argv.slice(2);

  // A command is only present when the first argument is not a flag. Without
  // this check `npm run keygen -- --machine X --client Y` has "--machine"
  // treated as the command and X/Y never parsed, so the run reports missing
  // arguments it was actually given.
  const command = argv[0]?.startsWith("--") === true ? undefined : argv[0];
  const flags = parseArgs(argv.slice(command === undefined ? 0 : 1));

  let exitCode = 0;
  try {
    switch (command) {
      case "init":
      case ":init":
        commandInit(flags);
        return;
      case "verify":
      case ":verify":
        exitCode = commandVerify(flags);
        break;
      case "inspect":
      case ":inspect":
        exitCode = commandInspect(flags);
        break;
      case "check":
      case ":check":
        exitCode = commandCheck();
        break;
      default:
        exitCode = commandGenerate(flags);
        break;
    }
  } catch (error) {
    console.error("Error:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  process.exit(exitCode);
}

main();
