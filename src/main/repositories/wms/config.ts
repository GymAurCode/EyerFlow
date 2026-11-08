import type { SqliteDatabase } from "../../../data/connection";
import { wmsSettingsSchema, type WmsSettings } from "../../../shared/wms";
import { recordAudit, type AuditActor } from "../../audit-writer";
export function readWmsSettings(db: SqliteDatabase): WmsSettings {
  const rows = db.prepare("SELECT key,value FROM wms_config").all() as {
    key: string;
    value: string;
  }[];
  return {
    autoPutaway: rows.find((r) => r.key === "autoPutaway")?.value === "1",
    pickFaceFirst: rows.find((r) => r.key === "pickFaceFirst")?.value === "1",
  };
}
export function saveWmsSettings(
  db: SqliteDatabase,
  actor: AuditActor,
  input: WmsSettings,
  nowIso: string,
): WmsSettings {
  const p = wmsSettingsSchema.parse(input);
  return db
    .transaction(() => {
      for (const [key, value] of Object.entries(p))
        db.prepare("UPDATE wms_config SET value=?,updated_at=? WHERE key=?").run(
          value ? "1" : "0",
          nowIso,
          key,
        );
      recordAudit(
        db,
        actor,
        {
          module: "warehouse",
          action: "settings",
          entityType: "wmsSettings",
          entityId: null,
          newValues: p,
        },
        nowIso,
      );
      return readWmsSettings(db);
    })
    .immediate();
}
