/**
 * Machine ID generation for offline licensing.
 *
 * Generates a stable hardware-based identifier by hashing together
 * multiple system identifiers. The goal is to survive OS reinstalls
 * while changing when the underlying hardware changes significantly.
 *
 * Two properties matter as much as the identifier itself:
 *
 * 1. It must never block the main process. Each source is read by a short-lived
 *    helper process, collected asynchronously. It used to be `execSync`, which
 *    froze the whole main process for seconds on Windows (three sequential
 *    PowerShell launches); because an IPC handler was serving the activation
 *    screen, that freeze read to the user as a button that never stopped
 *    spinning.
 *
 * 2. It must be the *same* every time it is read on one computer. A helper that
 *    times out under load would silently drop a component from the hash and
 *    produce a different ID, which invalidates every key ever issued for that
 *    machine. Each source is therefore also remembered on disk, and a source
 *    that fails today falls back to the value last read successfully.
 */

import { createHash } from "node:crypto";
import { platform } from "node:os";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { app } from "electron";

let cachedMachineId: string | null = null;
let inFlight: Promise<string> | null = null;

/** Ceiling per helper process. Generous, because the worst cost of waiting is
 *  a slow start rather than a wrong machine ID - but still bounded. */
const COMMAND_TIMEOUT_MS = 8_000;
const COMMAND_ATTEMPTS = 2;

/** Last successfully read value of each source, keyed by its prefix. */
type SourceValues = Record<string, string>;

const SOURCE_CACHE_FILE = "machine-id-sources.json";

/**
 * Run one helper command, retrying once, and return its trimmed output.
 *
 * Null means "could not read this right now" - never "this machine has no such
 * value". The two are treated differently: a permanent absence falls back to
 * the hash of the data directory, a transient failure falls back to the last
 * value read for this computer.
 */
async function run(file: string, args: string[]): Promise<string | null> {
  for (let attempt = 0; attempt < COMMAND_ATTEMPTS; attempt++) {
    const output = await new Promise<string | null>((resolve) => {
      execFile(
        file,
        args,
        { timeout: COMMAND_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
        (error, stdout) => {
          if (error !== null) {
            resolve(null);
            return;
          }
          const text = stdout.trim();
          resolve(text === "" ? null : text);
        },
      );
    });

    if (output !== null) return output;
  }

  return null;
}

/** PowerShell with a fixed script; the script is passed as argv, never through a shell. */
function powershell(script: string): Promise<string | null> {
  return run("powershell", ["-NoProfile", "-NonInteractive", "-Command", script]);
}

/**
 * Get a cross-platform machine ID.
 *
 * Strategy:
 * - Windows: MachineGuid from registry + CPU ID + primary disk serial
 * - Linux: /etc/machine-id + /proc/cpuinfo + /sys/block/sda/serial
 * - macOS: IOPlatformUUID + CPU + disk serial
 *
 * All sources are hashed together so no single component can be spoofed
 * without the others. The result is a 64-char hex string.
 *
 * Resolves from cache after the first call; concurrent callers share one
 * collection run.
 */
export function getMachineId(): Promise<string> {
  if (cachedMachineId !== null) return Promise.resolve(cachedMachineId);
  if (inFlight !== null) return inFlight;

  inFlight = collectMachineId()
    .then((id) => {
      cachedMachineId = id;
      return id;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

/**
 * Start collecting the machine ID without waiting for it.
 *
 * Called at startup so the value is usually ready before the renderer asks for
 * it; the activation screen can then show it immediately instead of after a
 * multi-second pause.
 */
export function warmMachineId(): void {
  void getMachineId().catch(() => undefined);
}

async function collectMachineId(): Promise<string> {
  const current = platform();
  const live =
    current === "win32"
      ? await getWindowsSources()
      : current === "linux"
        ? await getLinuxSources()
        : current === "darwin"
          ? await getMacSources()
          : {};

  const remembered = await readRememberedSources();

  // A source that could not be read right now keeps the value it had the last
  // time it could. This is what keeps the ID stable across a slow boot.
  const merged: SourceValues = { ...remembered };
  for (const [key, value] of Object.entries(live)) {
    if (value !== null) merged[key] = value;
  }

  const parts = Object.entries(merged)
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([key, value]) => `${key}:${value}`);

  // Nothing readable, now or ever: fall back to the data directory so the app
  // still runs. The ID then depends on where the data lives, which is a weaker
  // guarantee but a working one.
  if (parts.length === 0) {
    return createHash("sha256").update(app.getPath("userData")).digest("hex");
  }

  await writeRememberedSources(merged);

  return createHash("sha256").update(parts.join("|")).digest("hex");
}

/**
 * Get hardware identifiers on Windows.
 * Uses WMI via PowerShell for CPU and disk, registry for MachineGuid.
 *
 * The three queries run concurrently: PowerShell start-up dominates each one, so
 * running them in series cost seconds of stalled main process.
 */
async function getWindowsSources(): Promise<SourceValues> {
  const [machineGuid, cpuId, diskSerial] = await Promise.all([
    powershell(
      "Get-ItemProperty HKLM:\\SOFTWARE\\Microsoft\\Cryptography -Name MachineGuid | Select-Object -ExpandProperty MachineGuid",
    ),
    powershell("Get-CimInstance Win32_Processor | Select-Object -ExpandProperty ProcessorId"),
    powershell(
      `Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'" | Select-Object -ExpandProperty VolumeSerialNumber`,
    ),
  ]);

  return withoutNulls({
    "machine-guid": machineGuid,
    cpu: cpuId,
    disk: diskSerial,
  });
}

/**
 * Get hardware identifiers on Linux.
 */
async function getLinuxSources(): Promise<SourceValues> {
  const [machineId, cpuId, diskSerial] = await Promise.all([
    readFirstExisting(["/etc/machine-id", "/var/lib/dbus/machine-id"]),
    readTrimmed("/proc/cpuinfo").then((text) => {
      const match = text === null ? null : /Serial\s*:\s*(\S+)/.exec(text);
      return match === null ? null : (match[1] ?? null);
    }),
    readTrimmed("/sys/block/sda/serial"),
  ]);

  return withoutNulls({
    "machine-id": machineId,
    cpu: cpuId,
    disk: diskSerial,
  });
}

/**
 * Get hardware identifiers on macOS.
 */
async function getMacSources(): Promise<SourceValues> {
  const [platformUuid, cpu, disk] = await Promise.all([
    run("sh", [
      "-c",
      "ioreg -rd1 -c IOPlatformExpertDevice | awk '/IOPlatformUUID/ {print $3}' | tr -d '\"'",
    ]),
    run("sysctl", ["-n", "machdep.cpu.brand_string"]),
    run("sh", ["-c", "diskutil info / | awk '/Volume UUID/ {print $3}'"]),
  ]);

  return withoutNulls({
    "platform-uuid": platformUuid,
    cpu,
    disk,
  });
}

function withoutNulls(values: Record<string, string | null>): SourceValues {
  const result: SourceValues = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== null) result[key] = value;
  }
  return result;
}

async function readTrimmed(path: string): Promise<string | null> {
  try {
    const text = await readFile(path, "utf8");
    const value = text.trim();
    return value === "" ? null : value;
  } catch {
    return null;
  }
}

async function readFirstExisting(paths: string[]): Promise<string | null> {
  for (const path of paths) {
    if (!existsSync(path)) continue;
    const value = await readTrimmed(path);
    if (value !== null) return value;
  }
  return null;
}

/** Where the remembered source values live; the data folder, never the install. */
function rememberedSourcesPath(): string {
  return join(app.getPath("userData"), SOURCE_CACHE_FILE);
}

async function readRememberedSources(): Promise<SourceValues> {
  try {
    const parsed: unknown = JSON.parse(await readFile(rememberedSourcesPath(), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return {};

    const values: SourceValues = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string" && value !== "") values[key] = value;
    }
    return values;
  } catch {
    // No cache yet, or it was damaged: the live values simply win.
    return {};
  }
}

async function writeRememberedSources(values: SourceValues): Promise<void> {
  try {
    await writeFile(rememberedSourcesPath(), JSON.stringify(values, null, 2), "utf8");
  } catch {
    // Read-only or full data folder: not fatal, it only costs stability.
  }
}

/**
 * Reset the cached machine ID (for testing).
 */
export function resetMachineIdCache(): void {
  cachedMachineId = null;
  inFlight = null;
}
