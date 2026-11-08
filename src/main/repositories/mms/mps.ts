import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "../../../data/connection";
import type {
  MpsPlanDto,
  MpsPlanListRequest,
  SaveMpsPlanRequest,
  MpsBucketDto,
  PlanningHistoryDto,
} from "../../../shared/mms";
import { recordAudit, type AuditActor } from "../../audit-writer";
import {
  PlanningError,
  addDays,
  checkPeriod,
  checkLocation,
  product,
  available,
  approvedBom,
  supplies,
  planningMo,
} from "./planning-common";
import { purchaseSupply } from "./planning-supply";
type Row = Record<string, string | number | null>;
function buckets(db: SqliteDatabase, id: number): MpsBucketDto[] {
  return (
    db
      .prepare("SELECT * FROM manufacturing_mps_buckets WHERE plan_id=? ORDER BY bucket_date")
      .all(id) as Row[]
  ).map((r) => ({
    id: Number(r.id),
    bucketDate: String(r.bucket_date),
    endDate: String(r.end_date),
    openingStock: Number(r.opening_stock),
    forecastDemand: Number(r.forecast_demand),
    confirmedDemand: Number(r.confirmed_demand),
    demand: Number(r.demand),
    scheduledReceipts: Number(r.scheduled_receipts),
    plannedProduction: Number(r.planned_production),
    projectedStock: Number(r.projected_stock),
    shortage: Number(r.shortage),
    recommendedProduction: Number(r.recommended_production),
    generatedMoId: r.generated_mo_id == null ? null : Number(r.generated_mo_id),
  }));
}
export function getMpsPlan(db: SqliteDatabase, id: number): MpsPlanDto {
  const r = db
    .prepare(
      "SELECT m.*,p.sku,p.name,p.unit FROM manufacturing_mps_plans m JOIN products p ON p.id=m.product_id WHERE m.id=?",
    )
    .get(id) as Row | undefined;
  if (!r) throw new PlanningError("The production schedule was not found in this company.");
  return {
    id: Number(r.id),
    planKey: String(r.plan_key),
    bucketDate: String(r.bucket_date),
    periodEnd: String(r.period_end ?? r.bucket_date),
    horizon: String(r.horizon) as MpsPlanDto["horizon"],
    status: String(r.status) as MpsPlanDto["status"],
    locationId: r.location_id == null ? null : Number(r.location_id),
    bomId: r.bom_id == null ? null : Number(r.bom_id),
    productId: Number(r.product_id),
    productSku: String(r.sku),
    productName: String(r.name),
    productUnit: String(r.unit),
    plannedDemand: Number(r.planned_demand),
    confirmedDemand: Number(r.confirmed_demand),
    forecastDemand: Number(r.forecast_demand),
    openingStock: Number(r.opening_stock),
    projectedStock: Number(r.projected_stock),
    safetyStock: Number(r.safety_stock),
    expectedProduction: Number(r.expected_production),
    expectedShortage: Number(r.expected_shortage),
    plannedProduction: Number(r.planned_production),
    scheduledReceipts: Number(r.scheduled_receipts),
    recommendedProduction: Number(r.recommended_production),
    revision: Number(r.revision),
    createdAt: String(r.created_at),
    buckets: buckets(db, id),
  };
}
export function listMpsPlans(db: SqliteDatabase, r: MpsPlanListRequest): MpsPlanDto[] {
  const clauses: string[] = [],
    params: (string | number)[] = [];
  if (r.productId) {
    clauses.push("product_id=?");
    params.push(r.productId);
  }
  if (r.fromDate) {
    clauses.push("COALESCE(period_end,bucket_date)>=?");
    params.push(r.fromDate);
  }
  if (r.toDate) {
    clauses.push("bucket_date<=?");
    params.push(r.toDate);
  }
  return (
    db
      .prepare(
        `SELECT id FROM manufacturing_mps_plans ${clauses.length ? "WHERE " + clauses.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`,
      )
      .all(...params, r.limit ?? 500) as { id: number }[]
  ).map((p) => getMpsPlan(db, p.id));
}
function history(db: SqliteDatabase, id: number, op: string, actor: AuditActor, now: string): void {
  const p = getMpsPlan(db, id);
  db.prepare(
    "INSERT INTO manufacturing_mps_history(plan_id,revision,operation,snapshot_json,actor_name,created_at) VALUES(?,?,?,?,?,?)",
  ).run(id, p.revision, op, JSON.stringify(p), actor.name, now);
  recordAudit(
    db,
    actor,
    { module: "manufacturing", action: op, entityType: "mpsPlan", entityId: id },
    now,
  );
}
export function listMpsHistory(db: SqliteDatabase, id: number): PlanningHistoryDto[] {
  getMpsPlan(db, id);
  return db
    .prepare(
      `SELECT id,revision,operation,snapshot_json AS snapshotJson,actor_name AS actorName,created_at AS createdAt
    FROM manufacturing_mps_history WHERE plan_id=? ORDER BY id DESC`,
    )
    .all(id) as PlanningHistoryDto[];
}
export function calculateMps(
  db: SqliteDatabase,
  id: number,
  actor: AuditActor,
  now: string,
): MpsPlanDto {
  return db.transaction(() => {
    const p = getMpsPlan(db, id);
    if (p.status !== "draft") throw new PlanningError("Only a draft schedule can be recalculated.");
    checkPeriod(p.bucketDate, p.periodEnd);
    checkLocation(db, p.locationId);
    const ranges: { from: string; to: string }[] = [];
    for (let start = p.bucketDate; start <= p.periodEnd;) {
      let next = addDays(start, p.horizon === "weekly" ? 7 : 1);
      if (p.horizon === "monthly") {
        const d = new Date(start + "T00:00:00Z");
        d.setUTCMonth(d.getUTCMonth() + 1, 1);
        next = d.toISOString().slice(0, 10);
      }
      ranges.push({ from: start, to: next > p.periodEnd ? p.periodEnd : addDays(next, -1) });
      start = next;
    }
    const share = (q: number, i: number) =>
      Math.floor(q / ranges.length) + (i < q % ranges.length ? 1 : 0);
    const incoming = [
      ...supplies(db, p.productId, p.periodEnd, p.locationId),
      ...purchaseSupply(db, p.productId, p.locationId),
    ];
    let stock = available(db, p.productId, p.locationId),
      funded = stock,
      recommended = 0,
      receipts = 0,
      shortage = 0;
    const opening = stock;
    db.prepare("DELETE FROM manufacturing_mps_buckets WHERE plan_id=?").run(id);
    ranges.forEach((r, i) => {
      const forecast = share(p.forecastDemand, i),
        confirmed = share(p.confirmedDemand, i),
        demand = Math.max(forecast, confirmed),
        planned = share(p.plannedProduction, i);
      const supply = incoming
        .filter((s) => s.date <= r.to && (i === 0 || s.date >= r.from))
        .reduce((sum, s) => sum + s.quantity, 0);
      const end = stock + supply + planned - demand,
        need = Math.max(0, p.safetyStock - (funded + supply + planned - demand));
      db.prepare(
        `INSERT INTO manufacturing_mps_buckets(plan_id,bucket_date,end_date,opening_stock,forecast_demand,confirmed_demand,demand,scheduled_receipts,
        planned_production,projected_stock,shortage,recommended_production) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        id,
        r.from,
        r.to,
        stock,
        forecast,
        confirmed,
        demand,
        supply,
        planned,
        end,
        Math.max(0, p.safetyStock - end),
        need,
      );
      stock = end;
      funded += supply + planned + need - demand;
      recommended += need;
      receipts += supply;
      shortage = Math.max(shortage, p.safetyStock - end);
    });
    db.prepare(
      `UPDATE manufacturing_mps_plans SET opening_stock=?,projected_stock=?,planned_demand=?,scheduled_receipts=?,expected_production=?,expected_shortage=?,
      recommended_production=?,revision=revision+1,updated_at=? WHERE id=?`,
    ).run(
      opening,
      stock,
      Math.max(p.forecastDemand, p.confirmedDemand),
      receipts,
      receipts + p.plannedProduction,
      Math.max(0, shortage),
      recommended,
      now,
      id,
    );
    history(db, id, "calculate", actor, now);
    return getMpsPlan(db, id);
  })();
}
export function saveMpsPlan(
  db: SqliteDatabase,
  a: SaveMpsPlanRequest,
  actor: AuditActor,
  now: string,
): MpsPlanDto {
  return db.transaction(() => {
    checkPeriod(a.fromDate, a.toDate);
    checkLocation(db, a.locationId);
    product(db, a.productId);
    if (!approvedBom(db, a.productId, a.toDate, a.bomId))
      throw new PlanningError("Choose an approved BOM effective for this schedule.");
    let id = a.id;
    if (id !== undefined) {
      const before = getMpsPlan(db, id);
      if (before.status !== "draft")
        throw new PlanningError(
          "Approved schedules are immutable. Create another schedule for new demand.",
        );
      if (a.revision !== before.revision)
        throw new PlanningError("This schedule changed. Reload before saving.");
      db.prepare(
        `UPDATE manufacturing_mps_plans SET bucket_date=?,period_end=?,product_id=?,bom_id=?,location_id=?,horizon=?,forecast_demand=?,confirmed_demand=?,planned_production=?,safety_stock=? WHERE id=?`,
      ).run(
        a.fromDate,
        a.toDate,
        a.productId,
        a.bomId,
        a.locationId ?? null,
        a.horizon,
        a.forecastDemand,
        a.confirmedDemand,
        a.plannedProduction,
        a.safetyStock,
        id,
      );
    } else {
      id = Number(
        db
          .prepare(
            `INSERT INTO manufacturing_mps_plans(plan_key,bucket_date,period_end,product_id,bom_id,location_id,horizon,forecast_demand,confirmed_demand,planned_production,safety_stock,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            "MPS-" + randomUUID(),
            a.fromDate,
            a.toDate,
            a.productId,
            a.bomId,
            a.locationId ?? null,
            a.horizon,
            a.forecastDemand,
            a.confirmedDemand,
            a.plannedProduction,
            a.safetyStock,
            now,
            now,
          ).lastInsertRowid,
      );
    }
    return calculateMps(db, id, actor, now);
  })();
}
export function approveMps(
  db: SqliteDatabase,
  id: number,
  actor: AuditActor,
  now: string,
): MpsPlanDto {
  return db.transaction(() => {
    const p = getMpsPlan(db, id);
    if (p.status !== "draft") return p;
    calculateMps(db, id, actor, now);
    db.prepare("UPDATE manufacturing_mps_plans SET status='approved',updated_at=? WHERE id=?").run(
      now,
      id,
    );
    history(db, id, "approve", actor, now);
    return getMpsPlan(db, id);
  })();
}
export function generateMpsOrders(
  db: SqliteDatabase,
  id: number,
  actor: AuditActor,
  now: string,
): MpsPlanDto {
  return db.transaction(() => {
    const p = getMpsPlan(db, id);
    if (p.status === "draft")
      throw new PlanningError("Approve the schedule before generating orders.");
    if (p.status === "converted") return p;
    const incoming = [
      ...supplies(db, p.productId, p.periodEnd, p.locationId),
      ...purchaseSupply(db, p.productId, p.locationId),
    ];
    if (
      available(db, p.productId, p.locationId) !== p.openingStock ||
      p.buckets.some(
        (b, i) =>
          incoming
            .filter((s) => s.date <= b.endDate && (i === 0 || s.date >= b.bucketDate))
            .reduce((sum, s) => sum + s.quantity, 0) !== b.scheduledReceipts,
      )
    )
      throw new PlanningError(
        "Stock or expected supply changed after approval. Create a revised schedule before generating orders.",
      );
    for (const b of p.buckets) {
      const qty = b.plannedProduction + b.recommendedProduction;
      if (qty <= 0 || b.generatedMoId !== null) continue;
      const moId = planningMo(
        db,
        actor,
        {
          productId: p.productId,
          bomId: p.bomId!,
          quantity: qty,
          fromDate: b.bucketDate,
          toDate: b.endDate,
          locationId: p.locationId,
          reference: `MPS:${p.id}:bucket:${b.id}`,
        },
        now,
      );
      db.prepare(
        "UPDATE manufacturing_mps_buckets SET generated_mo_id=? WHERE id=? AND generated_mo_id IS NULL",
      ).run(moId, b.id);
    }
    db.prepare("UPDATE manufacturing_mps_plans SET status='converted',updated_at=? WHERE id=?").run(
      now,
      id,
    );
    history(db, id, "generateOrders", actor, now);
    return getMpsPlan(db, id);
  })();
}
