"use strict";

/**
 * Verify a built installer exists and reports its size.
 *
 * Exists so the release step fails loudly if packaging silently produced
 * nothing, which is easy to miss in a long build log.
 *
 * Usage: node scripts/verify-installer.js [expected-version]
 */

const fs = require("node:fs");
const path = require("node:path");

const pkg = require(path.join(process.cwd(), "package.json"));

const expectedVersion = process.argv[2] ?? pkg.version;
const releaseDir = path.join(process.cwd(), "release");
const expected = path.join(releaseDir, `${pkg.productName}-Setup-${expectedVersion}.exe`);

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

if (!fs.existsSync(releaseDir)) {
  fail(`No release directory at ${releaseDir}. Run "npm run dist" first.`);
}

if (!fs.existsSync(expected)) {
  const found = fs.readdirSync(releaseDir).filter((name) => name.endsWith(".exe"));
  fail(
    `Expected installer not found: ${expected}\nInstallers present: ${found.join(", ") || "(none)"}`,
  );
}

const sizeBytes = fs.statSync(expected).size;
if (sizeBytes < 10 * 1024 * 1024) {
  fail(`Installer is only ${sizeBytes} bytes, which is far too small for an Electron app.`);
}

const unpackedExe = path.join(releaseDir, "win-unpacked", `${pkg.productName}.exe`);
const unpackedOk = fs.existsSync(unpackedExe);

console.log("Installer verified:");
console.log(`  file:   ${path.basename(expected)}`);
console.log(`  size:   ${(sizeBytes / 1024 / 1024).toFixed(2)} MB`);
console.log(`  version: ${expectedVersion}`);
console.log(`  unpacked app present: ${unpackedOk ? "yes" : "no"}`);
