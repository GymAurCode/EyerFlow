"use strict";

/**
 * Fetch and unpack the Electron binary into node_modules/electron.
 *
 * Workaround for environments where electron's own postinstall script is
 * skipped (ELECTRON_SKIP_BINARY_DOWNLOAD, offline mirrors, `--ignore-scripts`).
 * The download itself is the normal, official GitHub release artifact via
 * @electron/get, so nothing custom or third-party is introduced.
 */

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { downloadArtifact } = require("@electron/get");

const root = process.cwd();
const electronDir = path.join(root, "node_modules", "electron");
const version = require(path.join(electronDir, "package.json")).version;

const EXECUTABLE = process.platform === "win32" ? "electron.exe" : "electron";

async function main() {
  const executablePath = path.join(electronDir, "dist", EXECUTABLE);
  if (fs.existsSync(executablePath) && fs.existsSync(path.join(electronDir, "path.txt"))) {
    console.log(`Electron ${version} is already installed.`);
    return;
  }

  console.log(`Downloading Electron ${version}...`);
  const zipPath = await downloadArtifact({
    version,
    artifactName: "electron",
    platform: process.platform,
    arch: process.arch,
  });

  const distDir = path.join(electronDir, "dist");
  fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(distDir, { recursive: true });

  // extract-zip 2.x silently extracted only part of this archive on Windows
  // (symlink handling for entries like icudtl.dat), leaving no executable.
  // The OS archiver is used instead: it is always present on Windows and is
  // what the platform itself relies on.
  if (process.platform === "win32") {
    execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Add-Type -AssemblyName System.IO.Compression.FileSystem; ` +
          `[System.IO.Compression.ZipFile]::ExtractToDirectory('${zipPath.replace(/'/g, "''")}', '${distDir.replace(/'/g, "''")}')`,
      ],
      { stdio: "inherit" },
    );
  } else {
    execFileSync("unzip", ["-q", "-o", zipPath, "-d", distDir], { stdio: "inherit" });
  }

  const nestedTypes = path.join(distDir, "electron.d.ts");
  if (fs.existsSync(nestedTypes)) {
    fs.renameSync(nestedTypes, path.join(electronDir, "electron.d.ts"));
  }

  if (!fs.existsSync(path.join(distDir, EXECUTABLE))) {
    throw new Error(`Extraction finished but ${EXECUTABLE} is missing from ${distDir}`);
  }

  fs.writeFileSync(path.join(electronDir, "path.txt"), EXECUTABLE);
  console.log("Electron installed.");
}

main().catch((error) => {
  console.error(`Failed to install Electron: ${error.message}`);
  process.exit(1);
});
