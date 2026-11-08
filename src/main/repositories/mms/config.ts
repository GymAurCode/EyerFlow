/**
 * MMS configuration repository.
 *
 * Production policies, cost rates, quality rules and approval policies.
 * Values are stored as key/string in `mms_config` and read through a typed
 * DTO. Server-enforced; the renderer never reads the table directly.
 */

import type { SqliteDatabase } from "../../../data/connection";
import type { MmsConfigDto, MmsConfigPatch } from "../../../shared/types";
import type { AuditActor } from "../../audit-writer";
import { recordAudit } from "../../audit-writer";

export class MmsConfigError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "MmsConfigError";
  }
}

const BOOL_KEYS = new Set([
  "allowBackflush",
  "requireQCBeforeReceipt",
  "autoCreateWorkOrders",
]);

const INT_KEYS = new Set(["scrapAllowancePercent", "overheadRateFilsPerHour"]);

const DEFAULT_CONFIG: MmsConfigDto = {
  negativeStockPolicy: "block",
  defaultCostingMethod: "standard",
  allowBackflush: false,
  requireQCBeforeReceipt: true,
  scrapAllowancePercent: 5,
  overheadRateFilsPerHour: 0,
  autoCreateWorkOrders: true,
};

function readRow(db: SqliteDatabase, key: string): string | null {
  const row = db.prepare("SELECT value FROM mms_config WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function readConfig(db: SqliteDatabase): MmsConfigDto {
  const get = (key: keyof MmsConfigDto, fallback: string | boolean | number): unknown => {
    const value = readRow(db, key);
    if (value === null) return fallback;
    if (typeof fallback === "boolean") return value === "1" || value.toLowerCase() === "true";
    if (typeof fallback === "number") {
      const n = Number.parseInt(value, 10);
      return Number.isFinite(n) ? n : fallback;
    }
    return value;
  };

  return {
    negativeStockPolicy: (get("negativeStockPolicy", "block") as string) === "allow" ? "allow" : "block",
    defaultCostingMethod: (() => {
      const v = get("defaultCostingMethod", "standard") as string;
      return v === "weightedAverage" ? "weightedAverage" : v === "fifo" ? "fifo" : "standard";
    })(),
    allowBackflush: get("allowBackflush", false) as boolean,
    requireQCBeforeReceipt: get("requireQCBeforeReceipt", true) as boolean,
    scrapAllowancePercent: get("scrapAllowancePercent", 5) as number,
    overheadRateFilsPerHour: get("overheadRateFilsPerHour", 0) as number,
    autoCreateWorkOrders: get("autoCreateWorkOrders", true) as boolean,
  };
}

export function updateConfig(
  db: SqliteDatabase,
  actor: AuditActor,
  patch: MmsConfigPatch,
  nowIso: string,
): MmsConfigDto {
  return db.transaction((): MmsConfigDto => {
    const statement = db.prepare(
      `INSERT INTO mms_config (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    );

    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      const stored = typeof value === "boolean" ? (value ? "1" : "0") : String(value ?? "");
      statement.run(key, stored, nowIso);
    }

    recordAudit(
      db,
      actor,
      {
        module: "manufacturing",
        action: "update",
        entityType: "mmsConfig",
        entityId: "mms",
        newValues: patch,
      },
      nowIso,
    );

    return readConfig(db);
  })();
}
