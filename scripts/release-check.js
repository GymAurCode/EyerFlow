/**
 * Release guard.
 *
 * Run before electron-builder so a misconfigured release fails in CI rather than
 * shipping an unsigned installer that Windows SmartScreen blocks and that no
 * user can tell apart from malware.
 *
 * Two things are checked:
 *
 *  1. Version and CHANGELOG agree. A release with no changelog entry is how a
 *     shop ends up running 1.4.0 with 1.2.0's fixes described.
 *  2. Signing is configured, unless EYERSTOCK_REQUIRE_SIGNING is explicitly
 *     "false" for a local unsigned build.
 *
 * Usage: node scripts/release-check.js
 * Exit code 0 = safe to build, 1 = blocked.
 */

"use strict";

const { readFileSync, existsSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = resolve(__dirname, "..");
const problems = [];
const notes = [];

/* ---------------------------------------------------------------- version -- */

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const version = pkg.version;

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  problems.push(`package.json version "${version}" is not a plain semantic version.`);
}

/* --------------------------------------------------------------- changelog -- */

const changelogPath = join(ROOT, "CHANGELOG.md");

if (!existsSync(changelogPath)) {
  problems.push("CHANGELOG.md is missing. Every release needs a changelog entry.");
} else {
  const changelog = readFileSync(changelogPath, "utf8");
  // Accept an unreleased section: a release cut from main may still be staged.
  const hasVersion = new RegExp(`^##\\s+\\[?v?${version.replace(/\./g, "\\.")}\\]?`, "m").test(changelog);
  const hasUnreleased = /^##\s+\[?Unreleased\]?/m.test(changelog);

  if (!hasVersion && !hasUnreleased) {
    problems.push(`CHANGELOG.md has no entry for version ${version} and no Unreleased section.`);
  } else if (!hasVersion) {
    notes.push(`CHANGELOG.md has an Unreleased section but no ${version} heading yet.`);
  }
}

/* ----------------------------------------------------------------- signing -- */

/**
 * EYERSTOCK_REQUIRE_SIGNING defaults to true for any build that is not obviously a
 * local experiment, so the safe behaviour is also the default one.
 */
const requireSigning = (process.env["EYERSTOCK_REQUIRE_SIGNING"] ?? "true").toLowerCase() !== "false";

const hasPfx = Boolean(process.env["CSC_LINK"]?.trim()) && Boolean(process.env["CSC_KEY_PASSWORD"]?.trim());
const hasStoreCert = Boolean(process.env["WIN_CSC_LINK"]?.trim());

if (!requireSigning) {
  notes.push("EYERSTOCK_REQUIRE_SIGNING=false: building unsigned (local development build).");
} else if (hasPfx || hasStoreCert) {
  notes.push("Code signing credentials found: the installer will be signed.");
} else {
  problems.push(
    "No code-signing credentials found.\n" +
      "  Set CSC_LINK + CSC_KEY_PASSWORD (a .pfx) or WIN_CSC_LINK (a certificate thumbprint),\n" +
      "  or set EYERSTOCK_REQUIRE_SIGNING=false to build unsigned on purpose.",
  );
}

/* --------------------------------------------------------------- packaging -- */

const pkgBuild = pkg.build ?? {};
const nsis = pkgBuild.nsis ?? {};

if (nsis.deleteAppDataOnUninstall !== false) {
  problems.push(
    "nsis.deleteAppDataOnUninstall must stay false so the uninstaller keeps shop data by default.",
  );
}

if (!existsSync(join(ROOT, "build", "installer.nsh"))) {
  problems.push("build/installer.nsh is missing: the uninstaller would not ask about keeping data.");
}

if (nsis.include !== "build/installer.nsh") {
  problems.push('nsis.include must point at "build/installer.nsh".');
}

if (!existsSync(join(ROOT, "build", "icon.ico"))) {
  problems.push("build/icon.ico is missing. Run `npm run icons` to regenerate it.");
}

/* --------------------------------------------------------------- publishing -- */

/**
 * The update server.
 *
 * The application checks this repository's releases for a newer version, so
 * the owner and the repository have to be the real ones. The placeholders are
 * refused rather than built: an installer that points at a repository that
 * does not exist ships an application whose "check for updates" button fails
 * for every shop that installs it, and the mistake is invisible until then.
 */
const publish = pkgBuild.publish ?? {};
const owner = typeof publish.owner === "string" ? publish.owner : "";
const repo = typeof publish.repo === "string" ? publish.repo : "";

/**
 * The repository this checkout is connected to, when it can be worked out.
 *
 * The placeholder in package.json is easy to fill in wrongly, and the git
 * remote already says what the answer is. This is only a suggestion - the
 * check below still refuses to build until the placeholders are gone.
 */
function gitRemoteRepository() {
  try {
    const remote = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    const match = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(remote);
    if (match === null) return null;
    return { owner: match[1], repo: match[2] };
  } catch {
    // No git, no remote, or a remote that is not GitHub. Not an error: the
    // placeholders below are the real check.
    return null;
  }
}

const suggested = gitRemoteRepository();

if (publish.provider !== "github") {
  problems.push('build.publish.provider must be "github" for the in-app updater to work.');
}

if (owner.length === 0 || owner.includes("YOUR-GITHUB")) {
  problems.push(
    "build.publish.owner is not set.\n" +
      "  Put your GitHub account or organisation in package.json, for example\n" +
      '    "publish": { "provider": "github", "owner": "your-account", "repo": "eyerstock" }',
  );
}

if (repo.length === 0 || repo.includes("YOUR-GITHUB")) {
  problems.push(
    "build.publish.repo is not set.\n" +
      "  Put the repository name in package.json, for example\n" +
      '    "publish": { "provider": "github", "owner": "your-account", "repo": "eyerstock" }',
  );
}

if (suggested !== null && (owner.includes("YOUR-GITHUB") || repo.includes("YOUR-GITHUB"))) {
  problems.push(
    `  This checkout's GitHub remote is ${suggested.owner}/${suggested.repo}, which is almost\n` +
      "  certainly what belongs in those two fields.",
  );
}

if (owner.length > 0 && repo.length > 0 && !owner.includes("YOUR-GITHUB") && !repo.includes("YOUR-GITHUB")) {
  notes.push(`Updates will be served from github.com/${owner}/${repo}.`);
}

/* ------------------------------------------------------------------ report -- */

for (const note of notes) {
  process.stdout.write(`  note: ${note}\n`);
}

if (problems.length > 0) {
  process.stderr.write("\nRelease blocked:\n");
  for (const problem of problems) {
    process.stderr.write(`  - ${problem}\n`);
  }
  process.exit(1);
}

process.stdout.write(`Release checks passed for version ${version}.\n`);
