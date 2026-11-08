/**
 * Builds the native SQLite binding for BOTH ABIs the project needs.
 *
 * The same `better_sqlite3.node` binary cannot serve Electron and plain Node:
 * Electron 38 needs NODE_MODULE_VERSION 139, Node 24 needs 137. Both are
 * required on an ordinary developer machine because:
 *
 *   - `npm run dev` / `npm run dist` run inside Electron, so the binding in
 *     node_modules must be the Electron build.
 *   - `npm test` runs under plain Node, so the test suite needs the Node build.
 *
 * Rather than forcing the developer to remember which rebuild to run before
 * which command, both binaries are kept side by side in `build-native/` and
 * `src/data/connection.ts` picks the right one at runtime. The copy inside
 * node_modules is left as the Electron build, because that is what the packaged
 * app and `electron .` load.
 *
 * The script is idempotent: once both side copies exist it is a no-op, so it is
 * cheap to prepend to `test`, `dev` and `dist`. Both artifacts come from the
 * npm prebuild cache via prebuild-install / electron-rebuild, so no network
 * access and no C++ toolchain are required on a normal machine.
 */

"use strict";

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "build-native");
const MODULE_DIR = path.join(ROOT, "node_modules", "better-sqlite3-multiple-ciphers");
const MODULE_BINDING = path.join(MODULE_DIR, "build", "Release", "better_sqlite3.node");

/** Electron ABI binding, also left in place inside node_modules. */
const ELECTRON_BINDING = path.join(OUT_DIR, "better_sqlite3.electron.node");
/** Plain-Node ABI binding, used by vitest, the seed benchmark and CLI scripts. */
const NODE_BINDING = path.join(OUT_DIR, "better_sqlite3.node.node");

function run(command, args) {
  process.stdout.write(`  ${command} ${args.join(" ")}\n`);
  execFileSync(command, args, {
    cwd: ROOT,
    stdio: "inherit",
    shell: process.platform === "win32",
    // Electron rebuild shells out to node-gyp on Windows; the default 10s is
    // not enough when it has to unpack the SQLite amalgamation.
    timeout: 15 * 60 * 1000,
  });
}

function existing(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function bothBindingsReady() {
  return existing(ELECTRON_BINDING) > 0 && existing(NODE_BINDING) > 0;
}

/**
 * Make sure the binding inside node_modules is the Electron one.
 *
 * Cheap size comparison rather than a checksum: both builds come from the same
 * package version, so a size change means a different artifact was installed
 * (`npm install` drops the Node build back in) and the Electron copy has to be
 * restored.
 */
function installElectronBinding() {
  if (existing(MODULE_BINDING) === existing(ELECTRON_BINDING)) return;
  copyBinding(ELECTRON_BINDING, MODULE_BINDING);
}

function copyBinding(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function main() {
  if (bothBindingsReady()) {
    installElectronBinding();
    process.stdout.write("Native SQLite bindings already built for Electron and Node.\n");
    return;
  }

  process.stdout.write("Building native SQLite bindings...\n");
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // 1. Node ABI. `npm rebuild` re-runs the package install script, which calls
  //    prebuild-install and takes the cached `node-v137` artifact.
  if (existing(NODE_BINDING) === 0) {
    run("npm", ["rebuild", "better-sqlite3-multiple-ciphers"]);
    copyBinding(MODULE_BINDING, NODE_BINDING);
  }

  // 2. Electron ABI. electron-rebuild produces `electron-v139`, which is also
  //    the copy left inside node_modules for the app to load.
  run("npx", ["--no-install", "electron-rebuild", "-f", "-w", "better-sqlite3-multiple-ciphers"]);
  copyBinding(MODULE_BINDING, ELECTRON_BINDING);

  process.stdout.write(`Native SQLite bindings ready in ${OUT_DIR}\n`);
}

main();
