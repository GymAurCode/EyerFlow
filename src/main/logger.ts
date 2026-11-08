/**
 * Rotating file logging for the main process.
 *
 * Kept deliberately dependency-free: this app must work fully offline on a shop
 * machine, so log rotation is implemented here rather than pulling in a package
 * that may need network access at install time.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const DEFAULT_KEEP_FILES = 5;
const MAX_BYTES = 2 * 1024 * 1024;

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

function timestamp(): string {
  const now = new Date();
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`
  );
}

export function createLogger(logDir: string, keepFiles = DEFAULT_KEEP_FILES): Logger {
  mkdirSync(logDir, { recursive: true });

  const logPath = join(logDir, "main.log");

  const rotateIfNeeded = (): void => {
    if (!existsSync(logPath)) return;
    if (statSync(logPath).size < MAX_BYTES) return;

    // Shift main.log -> main.1.log -> main.2.log ... dropping the oldest.
    const oldest = join(logDir, `main.${keepFiles}.log`);
    if (existsSync(oldest)) {
      unlinkSync(oldest);
    }
    for (let index = keepFiles - 1; index >= 1; index -= 1) {
      const from = join(logDir, `main.${index}.log`);
      if (existsSync(from)) {
        renameSync(from, join(logDir, `main.${index + 1}.log`));
      }
    }
    renameSync(logPath, join(logDir, "main.1.log"));
  };

  const write = (level: LogLevel, message: string, context?: Record<string, unknown>): void => {
    const suffix = context === undefined ? "" : ` ${JSON.stringify(context)}`;
    const line = `${timestamp()} [${level.toUpperCase()}] ${message}${suffix}\n`;

    // Errors go to stderr as well so they surface in a terminal run.
    if (level === "error") {
      process.stderr.write(line);
    }

    try {
      rotateIfNeeded();
      appendFileSync(logPath, line, "utf8");
    } catch {
      // Logging must never take the app down. A full or read-only disk should
      // not stop a shop from taking a sale.
    }
  };

  return {
    debug: (message, context) => write("debug", message, context),
    info: (message, context) => write("info", message, context),
    warn: (message, context) => write("warn", message, context),
    error: (message, context) => write("error", message, context),
  };
}

/** Rotate orphaned per-crash logs left behind by a previous run. */
export function collectStaleLogs(logDir: string): string[] {
  if (!existsSync(logDir)) return [];
  return readdirSync(logDir)
    .filter((name) => name.startsWith("crash-") && name.endsWith(".log"))
    .map((name) => join(logDir, name));
}
