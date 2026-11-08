"use strict";

/**
 * Generate build/icon.ico (and build/icon.png) from the master artwork in
 * assets/Logo.png.
 *
 * The icon is generated rather than committed as an opaque binary so the
 * artwork is reviewable in source control and reproducible: replace
 * assets/Logo.png, run `npm run icons`, rebuild, and every surface that shows
 * the app icon - installer, desktop shortcut, taskbar, title bar - follows.
 *
 * No image libraries are used. An ICO may carry PNG-compressed images on
 * Windows Vista onwards, so the output is a small container wrapped around the
 * original PNG: no decoding, no resampling, and no lossy re-encode of the
 * artwork. Windows scales the one entry as needed per surface.
 *
 * Run with: node scripts/make-icon.js
 */

const fs = require("node:fs");
const path = require("node:path");

/** 0 in an ICO directory entry means 256, per the format. */
const ICO_ENTRY_SIZE = 0;

function readMasterPng() {
  const source = path.join(process.cwd(), "assets", "Logo.png");
  if (!fs.existsSync(source)) {
    throw new Error(`Master logo not found: ${source}`);
  }

  const png = fs.readFileSync(source);

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!png.subarray(0, 8).equals(signature)) {
    throw new Error(`Master logo is not a PNG: ${source}`);
  }

  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);

  if (width !== height) {
    process.stderr.write(`warning: ${source} is ${width}x${height}, expected square\n`);
  }
  if (width < 256) {
    process.stderr.write(`warning: ${source} is only ${width}px; icons will look soft\n`);
  }

  return png;
}

/** Wrap the PNG in a single-image ICO container. */
function buildIco(png) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // image type: 1 = icon (2 = cursor)
  header.writeUInt16LE(1, 4); // one image

  const entry = Buffer.alloc(16);
  entry[0] = ICO_ENTRY_SIZE; // width
  entry[1] = ICO_ENTRY_SIZE; // height
  entry[2] = 0; // palette size
  entry[3] = 0; // reserved
  entry.writeUInt16LE(1, 4); // colour planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(png.length, 8); // payload size in bytes
  entry.writeUInt32LE(header.length + entry.length, 12); // offset of the payload

  return Buffer.concat([header, entry, png]);
}

function main() {
  const png = readMasterPng();

  const outDir = path.join(process.cwd(), "build");
  fs.mkdirSync(outDir, { recursive: true });

  const icoPath = path.join(outDir, "icon.ico");
  fs.writeFileSync(icoPath, buildIco(png));

  // A PNG is also written for anything that prefers the artwork unpackaged.
  const pngPath = path.join(outDir, "icon.png");
  fs.writeFileSync(pngPath, png);

  console.log(`Wrote ${icoPath} (${fs.statSync(icoPath).size} bytes)`);
  console.log(`Wrote ${pngPath}`);
}

main();
