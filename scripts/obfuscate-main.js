/**
 * Post-build obfuscation for main process.
 *
 * Runs after TypeScript compilation to obfuscate the main process code
 * before Electron packages it into the ASAR archive.
 *
 * CommonJS, not ESM: this runs as `node scripts/obfuscate-main.js` and the
 * package is `"type": "commonjs"`, so an `import` statement here is a syntax
 * error and `npm run build:prod` fails before it obfuscates anything. It also
 * carries no TypeScript annotations, which is what lets Prettier and ESLint
 * parse it as the plain JavaScript it is.
 */

const { readFileSync, writeFileSync, existsSync, readdirSync, statSync } = require("node:fs");
const { join, basename } = require("node:path");
const { obfuscate } = require("javascript-obfuscator");

const DIST_MAIN = join(__dirname, "..", "dist", "main");

/**
 * Files that are shipped unobfuscated.
 *
 * Licence verification is excluded on purpose. Its correctness is not a matter
 * of taste: the string-array and control-flow transforms rewrite expressions
 * and literals in ways that are safe for ordinary code but have no business
 * touching the bytes an Ed25519 signature is computed over. `license-verify.ts`
 * is already written to be readable for the same reason - a failure here is one
 * a customer sees as "this key is not valid", with no way to diagnose.
 *
 * Everything else in `dist/main` is still obfuscated.
 */
const KEEP_READABLE = new Set(["license-verify.js"]);

function obfuscateFile(filePath) {
  const code = readFileSync(filePath, "utf8");

  // Don't obfuscate if already obfuscated (idempotent)
  if (code.includes("javascript-obfuscator")) return;

  const result = obfuscate(code, {
    compact: true,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.75,
    deadCodeInjection: true,
    deadCodeInjectionThreshold: 0.4,
    debugProtection: false,
    // `debugProtectionInterval` is deliberately left at its default. It was
    // pinned to `false` here, which javascript-obfuscator 4.x accepted as "off"
    // and 5.x rejects outright ("must be a number"), failing `npm run dist`
    // before a single file was obfuscated. `debugProtection: false` above is
    // what actually disables the feature; this value is never consulted.
    disableConsoleOutput: true,
    identifierNamesGenerator: "hexadecimal",
    log: false,
    numbersToExpressions: true,
    renameGlobals: false,
    rotateStringArray: true,
    selfDefending: true,
    shuffleStringArray: true,
    simplify: true,
    splitStrings: true,
    splitStringsChunkLength: 10,
    stringArray: true,
    stringArrayEncoding: ["rc4"],
    stringArrayThreshold: 0.75,
    transformObjectKeys: true,
    unicodeEscapeSequence: false,
    // Preserve these for Electron/Node compatibility
    reservedNames: [
      "require",
      "module",
      "exports",
      "global",
      "process",
      "Buffer",
      "console",
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "setImmediate",
      "clearImmediate",
    ],
    reservedStrings: [
      "electron",
      "better-sqlite3",
      "better-sqlite3-multiple-ciphers",
      "node:crypto",
      "node:fs",
      "node:path",
      "node:os",
      "node:child_process",
    ],
  });

  writeFileSync(filePath, result.getObfuscatedCode(), "utf8");
  console.log(`  Obfuscated: ${filePath}`);
}

function obfuscateDir(dir) {
  if (!existsSync(dir)) return;

  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      obfuscateDir(fullPath);
    } else if (entry.endsWith(".js") && !entry.endsWith(".map")) {
      if (KEEP_READABLE.has(basename(entry))) {
        console.log(`  Left readable: ${fullPath}`);
        continue;
      }
      obfuscateFile(fullPath);
    }
  }
}

console.log("Obfuscating main process code...");
obfuscateDir(DIST_MAIN);
console.log("Main process obfuscation complete.");
