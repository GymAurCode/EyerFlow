import type { SqliteDatabase } from "../../../data/connection";
import { availableQuantity, getLocation, defaultLocationId } from "../ims/stock";
import { saveManufacturingOrder } from "./manufacturingOrders";
import type { AuditActor } from "../../audit-writer";
export class PlanningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanningError";
  }
}
export function addDays(date: string, days: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
export function checkPeriod(from: string, to: string): void {
  const valid = (s: string) =>
    /^\d{4}-\d{2}-\d{2}$/.test(s) &&
    Number.isFinite(Date.parse(s)) &&
    new Date(s + "T00:00:00Z").toISOString().slice(0, 10) === s;
  if (!valid(from) || !valid(to) || from > to || addDays(from, 1095) < to)
    throw new PlanningError("Choose a valid planning period of at most three years.");
}
export function checkedQuantity(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000_000)
    throw new PlanningError("Quantity exceeds the supported planning range.");
  return value;
}
export function product(db: SqliteDatabase, id: number) {
  const r = db
    .prepare(
      "SELECT id,name,sku,unit,is_service,is_active,average_cost_fils FROM products WHERE id=?",
    )
    .get(id) as
    | {
        id: number;
        name: string;
        sku: string;
        unit: string;
        is_service: number;
        is_active: number;
        average_cost_fils: number;
      }
    | undefined;
  if (!r || r.is_service || !r.is_active)
    throw new PlanningError("Choose an active stocked product in this company.");
  return r;
}
export function checkLocation(db: SqliteDatabase, id?: number | null): void {
  if (id != null) getLocation(db, id);
}
export function available(db: SqliteDatabase, id: number, location?: number | null): number {
  return Math.max(0, availableQuantity(db, id, location));
}
export function approvedBom(
  db: SqliteDatabase,
  productId: number,
  date: string,
  bomId?: number | null,
) {
  const r = db
    .prepare(
      `SELECT id,product_id,base_output_quantity,output_unit,routing_id FROM manufacturing_boms
    WHERE product_id=? AND status='approved' AND effective_from<=? AND (effective_to IS NULL OR effective_to>=?)
    ${bomId ? "AND id=?" : ""} ORDER BY effective_from DESC,id DESC LIMIT 1`,
    )
    .get(productId, date, date, ...(bomId ? [bomId] : [])) as
    | {
        id: number;
        product_id: number;
        base_output_quantity: number;
        output_unit: string;
        routing_id: number | null;
      }
    | undefined;
  if (r && r.base_output_quantity <= 0)
    throw new PlanningError("The approved BOM has an invalid base output.");
  return r;
}
function unitRatio(db: SqliteDatabase, from: string, to: string): [bigint, bigint] {
  if (from === to) return [1n, 1n];
  const units = db
    .prepare(
      "SELECT code,base_code,factor_milli FROM ims_units WHERE code IN (?,?) AND is_active=1",
    )
    .all(from, to) as { code: string; base_code: string; factor_milli: number }[];
  const a = units.find((u) => u.code === from),
    b = units.find((u) => u.code === to);
  if (!a || !b || a.base_code !== b.base_code || a.factor_milli <= 0 || b.factor_milli <= 0)
    throw new PlanningError(`No compatible IMS unit conversion from ${from} to ${to}.`);
  return [BigInt(a.factor_milli), BigInt(b.factor_milli)];
}
function ceilRatio(numerator: bigint, denominator: bigint): number {
  return checkedQuantity(Number((numerator + denominator - 1n) / denominator));
}
export function convertUnits(db: SqliteDatabase, qty: number, from: string, to: string): number {
  const [a, b] = unitRatio(db, from, to);
  return ceilRatio(BigInt(checkedQuantity(qty)) * a, b);
}
export function components(
  db: SqliteDatabase,
  bom: NonNullable<ReturnType<typeof approvedBom>>,
  output: number,
) {
  const [baseNumerator, baseDenominator] = unitRatio(
    db,
    bom.output_unit,
    product(db, bom.product_id).unit,
  );
  const rows = db
    .prepare(
      `SELECT component_product_id AS productId,quantity_per_unit AS qty,unit,scrap_percent AS scrap
    FROM manufacturing_bom_components WHERE bom_id=? AND is_optional=0 ORDER BY line_no,id`,
    )
    .all(bom.id) as { productId: number; qty: number; unit: string; scrap: number }[];
  if (!rows.length)
    throw new PlanningError("An approved production BOM must contain required components.");
  return rows.map((r) => {
    const [a, b] = unitRatio(db, r.unit, product(db, r.productId).unit);
    // Round upward once, after scaling and conversion, without floating-point multiplication overflow.
    const scrap = BigInt(100_000_000 + Math.round(r.scrap * 1_000_000));
    return {
      productId: r.productId,
      quantity: ceilRatio(
        BigInt(checkedQuantity(r.qty)) *
          a *
          BigInt(checkedQuantity(output)) *
          baseDenominator *
          scrap,
        b * BigInt(bom.base_output_quantity) * baseNumerator * 100_000_000n,
      ),
    };
  });
}
export function moLocation(
  db: SqliteDatabase,
  locationId: number | null,
  plant: string | null,
): number {
  if (locationId !== null) return locationId;
  const match =
    plant === null
      ? undefined
      : (db
          .prepare(
            "SELECT id FROM ims_locations WHERE name=? AND is_active=1 ORDER BY is_default DESC,id LIMIT 1",
          )
          .get(plant) as { id: number } | undefined);
  return match?.id ?? defaultLocationId(db);
}
export interface Supply {
  date: string;
  quantity: number;
  sourceId: number;
  kind: string;
}
export function supplies(
  db: SqliteDatabase,
  productId: number,
  to: string,
  location?: number | null,
  excludeMoIds: readonly number[] = [],
): Supply[] {
  const rows = db
    .prepare(
      `SELECT id,MAX(0,planned_quantity-accepted_quantity) AS quantity,
    COALESCE(planned_finish,planned_start,substr(created_at,1,10)) AS date,planning_location_id,plant
    FROM manufacturing_orders WHERE product_id=? AND status IN ('planned','confirmed','released','inProgress','qualityReview')`,
    )
    .all(productId) as {
    id: number;
    quantity: number;
    date: string;
    planning_location_id: number | null;
    plant: string | null;
  }[];
  return rows
    .filter(
      (r) =>
        !excludeMoIds.includes(r.id) &&
        r.date <= to &&
        (location == null || moLocation(db, r.planning_location_id, r.plant) === location),
    )
    .map((r) => ({
      date: r.date,
      quantity: r.quantity,
      sourceId: r.id,
      kind: "manufacturingOrder",
    }));
}
export function planningMo(
  db: SqliteDatabase,
  actor: AuditActor,
  a: {
    productId: number;
    bomId: number;
    quantity: number;
    fromDate: string;
    toDate: string;
    locationId: number | null;
    reference: string;
  },
  now: string,
): number {
  const bom = approvedBom(db, a.productId, a.toDate, a.bomId);
  if (!bom)
    throw new PlanningError("The BOM is no longer approved or effective on the required date.");
  const mo = saveManufacturingOrder(
    db,
    actor,
    {
      productId: a.productId,
      bomId: bom.id,
      plannedQuantity: a.quantity,
      unit: product(db, a.productId).unit,
      routeId: bom.routing_id,
      plannedStart: a.fromDate,
      plannedFinish: a.toDate,
      plant: a.locationId === null ? null : getLocation(db, a.locationId).name,
      sourceDemand: a.reference,
    },
    now,
  );
  db.prepare("UPDATE manufacturing_orders SET planning_location_id=? WHERE id=?").run(
    a.locationId,
    mo.id,
  );
  // Planning supports batch BOMs and IMS base units; keep the MO service's normal audit/numbering.
  const grouped = new Map<number, number>();
  for (const c of components(db, bom, a.quantity))
    grouped.set(c.productId, (grouped.get(c.productId) ?? 0) + c.quantity);
  db.prepare("DELETE FROM manufacturing_order_components WHERE mo_id=?").run(mo.id);
  let line = 0;
  let materialCost = 0;
  for (const [id, qty] of grouped) {
    const p = product(db, id);
    materialCost += Math.round((qty * p.average_cost_fils) / 1000);
    db.prepare(
      `INSERT INTO manufacturing_order_components(mo_id,component_product_id,required_quantity,unit,line_no) VALUES(?,?,?,?,?)`,
    ).run(mo.id, id, qty, p.unit, ++line);
  }
  db.prepare("UPDATE manufacturing_orders SET planned_cost_fils=? WHERE id=?").run(
    materialCost,
    mo.id,
  );
  return mo.id;
}
