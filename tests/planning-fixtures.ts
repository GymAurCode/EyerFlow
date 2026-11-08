import { openInMemoryDatabase } from "../src/data/connection";
import { runMigrations } from "../src/data/migrator";
import { migrations } from "../src/data/migrations";
import { SYSTEM_ACTOR } from "../src/main/audit-writer";
import { saveProduct } from "../src/main/repositories/products";
import { saveBom, saveBomComponent, approveBom } from "../src/main/repositories/mms/bom";
import { postMovement, defaultLocationId } from "../src/main/repositories/ims/stock";
import type { SqliteDatabase } from "../src/data/connection";
export const NOW = "2026-11-07T10:00:00.000Z";
export const ACTOR = SYSTEM_ACTOR;
export function planningDb() {
  const db = openInMemoryDatabase();
  runMigrations(db, migrations);
  return db;
}
export function item(db: SqliteDatabase, name: string, quantity = 0, unit = "pcs") {
  const p = saveProduct(
    db,
    ACTOR,
    { sku: name, name, unit, vatTreatment: "standard", averageCostFils: 100 },
    NOW,
  );
  if (quantity)
    postMovement(
      {
        db,
        actorName: ACTOR.name,
        nowIso: NOW,
        nowDate: NOW.slice(0, 10),
        allowNegativeStock: false,
      },
      {
        productId: p.id,
        locationId: defaultLocationId(db),
        movementDate: NOW.slice(0, 10),
        kind: "opening",
        quantityMilli: quantity,
      },
    );
  return p.id;
}
export function bom(
  db: SqliteDatabase,
  parent: number,
  parts: { id: number; qty: number; unit?: string }[],
  base = 1000,
) {
  const b = saveBom(
    db,
    ACTOR,
    {
      productId: parent,
      name: "Production " + parent,
      baseOutputQuantity: base,
      outputUnit: "pcs",
      effectiveFrom: "2026-01-01",
    },
    NOW,
  );
  parts.forEach((p, i) =>
    saveBomComponent(
      db,
      ACTOR,
      {
        bomId: b.id,
        componentProductId: p.id,
        quantityPerUnit: p.qty,
        unit: p.unit ?? "pcs",
        lineNo: i + 1,
      },
      NOW,
    ),
  );
  approveBom(db, ACTOR, b.id, NOW);
  return b.id;
}
