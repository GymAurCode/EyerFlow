import { randomUUID, createHash } from "node:crypto";
import type { SqliteDatabase } from "../../../data/connection";
import type {
  MrpRunDto,
  MrpRunRequest,
  MrpRequirementDto,
  MrpRequirementListRequest,
} from "../../../shared/mms";
import { SYSTEM_ACTOR, recordAudit, type AuditActor } from "../../audit-writer";
import { sellableOnHand, reservedQuantity, defaultLocationId } from "../ims/stock";
import { saveOperation, type OperationContext } from "../ims/operations";
import { purchaseSupply } from "./planning-supply";
import {
  PlanningError,
  checkLocation,
  checkPeriod,
  checkedQuantity,
  addDays,
  approvedBom,
  components,
  product,
  supplies,
  planningMo,
  moLocation,
  type Supply,
} from "./planning-common";
type Row = Record<string, string | number | null>;
type Order = {
  id: number;
  number: string;
  product_id: number;
  bom_id: number;
  planned_quantity: number;
  actual_quantity: number;
  date: string;
  plant: string | null;
  planning_location_id: number | null;
  status: string;
};
type Demand = { date: string; qty: number; sources: Set<number> };
/** A saved recommendation may be approved/converted only while its business inputs are unchanged. */
function fingerprint(db: SqliteDatabase): string {
  const queries = [
    "SELECT id,unit,is_active,quantity_milli,average_cost_fils FROM products ORDER BY id",
    "SELECT id,product_id,location_id,quantity_milli,stock_status FROM stock_movements ORDER BY id",
    "SELECT id,product_id,location_id,quantity_milli,source_kind,source_id,status FROM ims_reservations ORDER BY id",
    "SELECT id,product_id,bom_id,planned_quantity,actual_quantity,accepted_quantity,status,planned_start,planned_finish,plant,planning_location_id FROM manufacturing_orders ORDER BY id",
    "SELECT mo_id,component_product_id,required_quantity,consumed_quantity,unit FROM manufacturing_order_components ORDER BY id",
    "SELECT mo_id,component_product_id,quantity_milli,issue_type FROM manufacturing_material_issues ORDER BY id",
    "SELECT id,product_id,status,base_output_quantity,output_unit,effective_from,effective_to,routing_id FROM manufacturing_boms ORDER BY id",
    "SELECT bom_id,component_product_id,quantity_per_unit,unit,scrap_percent,is_optional FROM manufacturing_bom_components ORDER BY id",
    "SELECT id,kind,status,from_location_id,to_location_id,source_id,issue_date,due_date,required_date,reference FROM ims_documents ORDER BY id",
    "SELECT document_id,source_line_id,product_id,quantity_milli,processed_milli FROM ims_document_lines ORDER BY id",
    "SELECT * FROM ims_reorder_rules ORDER BY product_id",
    "SELECT code,base_code,factor_milli,is_active FROM ims_units ORDER BY id",
  ];
  const hash = createHash("sha256");
  for (const sql of queries) hash.update(JSON.stringify(db.prepare(sql).all()));
  return hash.digest("hex");
}
function assertCurrent(db: SqliteDatabase, id: number): void {
  const saved = db
    .prepare("SELECT input_fingerprint AS value FROM manufacturing_mrp_runs WHERE id=?")
    .get(id) as { value: string | null };
  if (saved.value !== fingerprint(db))
    throw new PlanningError(
      "Planning inputs changed since this calculation. Run MRP again before approving or generating supply.",
    );
}
function rules(db: SqliteDatabase, id: number, location: number | null) {
  return db
    .prepare(
      `SELECT safety_milli,lead_time_days,preferred_supplier_id FROM ims_reorder_rules WHERE product_id=? AND (location_id IS NULL OR ? IS NULL OR location_id=?)`,
    )
    .get(id, location, location) as
    | { safety_milli: number; lead_time_days: number; preferred_supplier_id: number | null }
    | undefined;
}
function requestedSupply(db: SqliteDatabase, id: number, location: number | null): Supply[] {
  return (
    db
      .prepare(
        `SELECT d.id,COALESCE(d.required_date,d.issue_date) AS date,MAX(0,l.quantity_milli-l.processed_milli) AS qty
    FROM ims_documents d JOIN ims_document_lines l ON l.document_id=d.id WHERE d.kind='purchaseRequisition'
    AND d.status IN ('draft','submitted','approved') AND d.reference LIKE 'MRP:%' AND l.product_id=?
    AND (? IS NULL OR COALESCE(d.to_location_id,d.from_location_id,?)=?)
    AND NOT EXISTS(SELECT 1 FROM ims_documents po WHERE po.source_id=d.id AND po.kind='purchaseOrder' AND po.status NOT IN ('cancelled','rejected'))`,
      )
      .all(id, location, defaultLocationId(db), location) as {
      id: number;
      date: string;
      qty: number;
    }[]
  ).map((r) => ({ date: r.date, quantity: r.qty, sourceId: r.id, kind: "purchaseRequisition" }));
}
function take(supply: Supply[], date: string, max = Number.MAX_SAFE_INTEGER): number {
  let total = 0;
  for (const s of supply) {
    if (s.date > date || s.quantity <= 0) continue;
    const qty = Math.min(s.quantity, max - total);
    s.quantity -= qty;
    total += qty;
    if (total === max) break;
  }
  return total;
}
function mapRequirement(db: SqliteDatabase, r: Row): MrpRequirementDto {
  const ids = JSON.parse(String(r.source_mo_ids)) as number[];
  const names = ids
    .map(
      (id) =>
        (
          db.prepare("SELECT number FROM manufacturing_orders WHERE id=?").get(id) as
            { number: string } | undefined
        )?.number,
    )
    .filter(Boolean);
  return {
    id: Number(r.id),
    mrpRunId: Number(r.mrp_run_id),
    productId: Number(r.product_id),
    productSku: String(r.sku),
    productName: String(r.name),
    productUnit: String(r.unit),
    grossRequirement: Number(r.gross_requirement),
    availableSupply: Number(r.available_supply),
    netRequirement: Number(r.net_requirement),
    shortageQty: Number(r.shortage_qty),
    scheduledReceipts: Number(r.scheduled_receipts),
    reservedQuantity: Number(r.reserved_quantity),
    safetyStock: Number(r.safety_stock),
    requestedSupply: Number(r.requested_supply),
    suggestedQuantity: Number(r.suggested_quantity),
    plannedReleaseDate: r.planned_release_date == null ? null : String(r.planned_release_date),
    requiredByDate: r.required_by_date == null ? null : String(r.required_by_date),
    suggestedAction: r.suggested_action == null ? null : String(r.suggested_action),
    sourceMoIds: ids,
    sourceMoId: ids.length === 1 ? ids[0]! : null,
    sourceMoNumber: names.join(", ") || null,
    bomId: r.bom_id == null ? null : Number(r.bom_id),
    requisitionId: r.requisition_id == null ? null : Number(r.requisition_id),
    generatedMoId: r.generated_mo_id == null ? null : Number(r.generated_mo_id),
    createdAt: String(r.created_at),
  };
}
export function listMrpRequirements(
  db: SqliteDatabase,
  a: MrpRequirementListRequest,
): MrpRequirementDto[] {
  const clauses: string[] = [],
    params: number[] = [];
  if (a.mrpRunId) {
    clauses.push("r.mrp_run_id=?");
    params.push(a.mrpRunId);
  }
  if (a.productId) {
    clauses.push("r.product_id=?");
    params.push(a.productId);
  }
  if (a.shortageOnly) clauses.push("r.shortage_qty>0");
  return (
    db
      .prepare(
        `SELECT r.*,p.sku,p.name,p.unit FROM manufacturing_mrp_requirements r JOIN products p ON p.id=r.product_id
    ${clauses.length ? "WHERE " + clauses.join(" AND ") : ""} ORDER BY r.required_by_date,r.id LIMIT ?`,
      )
      .all(...params, a.limit ?? 5000) as Row[]
  ).map((r) => mapRequirement(db, r));
}
export function getMrpRun(db: SqliteDatabase, id: number): MrpRunDto {
  const r = db.prepare("SELECT * FROM manufacturing_mrp_runs WHERE id=?").get(id) as
    Row | undefined;
  if (!r) throw new PlanningError("The MRP run was not found in this company.");
  return {
    id: Number(r.id),
    runKey: String(r.run_key),
    runDate: String(r.run_date),
    locationId: r.location_id == null ? null : Number(r.location_id),
    status: String(r.status),
    fromDate: String(r.from_date),
    toDate: String(r.to_date),
    plant: r.plant == null ? null : String(r.plant),
    sourceMoIds: JSON.parse(String(r.source_mo_ids)) as number[],
    requirements: listMrpRequirements(db, { mrpRunId: id }),
  };
}
export function listMrpRuns(db: SqliteDatabase): MrpRunDto[] {
  return (
    db.prepare("SELECT id FROM manufacturing_mrp_runs ORDER BY id DESC LIMIT 100").all() as {
      id: number;
    }[]
  ).map((r) => getMrpRun(db, r.id));
}
export function runMrp(
  db: SqliteDatabase,
  a: MrpRunRequest,
  now: string,
  actor: AuditActor = SYSTEM_ACTOR,
): MrpRunDto {
  return db.transaction(() => {
    const from = a.fromDate ?? now.slice(0, 10),
      to = a.toDate ?? addDays(from, 89),
      location = a.locationId ?? null;
    checkPeriod(from, to);
    checkLocation(db, location);
    let orders = db
      .prepare(
        `SELECT id,number,product_id,bom_id,planned_quantity,actual_quantity,plant,planning_location_id,status,
      COALESCE(planned_start,planned_finish,substr(created_at,1,10)) AS date FROM manufacturing_orders
      WHERE status IN ('planned','confirmed','released','inProgress','qualityReview') ORDER BY id`,
      )
      .all() as Order[];
    orders = orders.filter(
      (o) =>
        o.date <= to &&
        (!a.plant || o.plant === a.plant) &&
        (location === null || moLocation(db, o.planning_location_id, o.plant) === location) &&
        (a.moIds === undefined || a.moIds.includes(o.id)),
    );
    if (a.moIds?.some((id) => !orders.some((o) => o.id === id)))
      throw new PlanningError(
        "A selected order is outside the company, branch, period or eligible planning status.",
      );
    if (orders.length > 200)
      throw new PlanningError("Select at most 200 manufacturing orders per MRP run.");
    const orderIds = orders.map((o) => o.id),
      scope = JSON.stringify({ ids: orderIds, from, to, location, plant: a.plant ?? null });
    // An older approved run must not be converted after a replacement run for the same demand was calculated.
    db.prepare(
      `UPDATE manufacturing_mrp_runs SET status='superseded' WHERE status IN ('completed','approved')
      AND (location_id IS NULL OR ? IS NULL OR location_id=?)`,
    ).run(location, location);
    const id = Number(
      db
        .prepare(
          `INSERT INTO manufacturing_mrp_runs(run_key,run_date,location_id,status,created_at,from_date,to_date,plant,source_mo_ids,scope_key)
      VALUES(?,?,?,'completed',?,?,?,?,?,?)`,
        )
        .run(
          "MRP-" + randomUUID(),
          now.slice(0, 10),
          location,
          now,
          from,
          to,
          a.plant ?? null,
          JSON.stringify(orderIds),
          scope,
        ).lastInsertRowid,
    );
    const events = new Map<number, Demand[]>(),
      graph = new Map<number, Set<number>>(),
      visiting = new Set<number>(),
      visited = new Set<number>(),
      ordered: number[] = [];
    function add(pid: number, date: string, qty: number, sources: Set<number>) {
      if (qty <= 0) return;
      checkedQuantity(qty);
      const list = events.get(pid) ?? [];
      const e = list.find((r) => r.date === date);
      if (e) {
        e.qty = checkedQuantity(e.qty + qty);
        sources.forEach((s) => e.sources.add(s));
      } else list.push({ date, qty, sources: new Set(sources) });
      events.set(pid, list);
    }
    function graphFor(pid: number, path: Set<number>) {
      if (path.has(pid))
        throw new PlanningError(
          "A circular BOM prevents MRP calculation. Correct the approved BOMs.",
        );
      if (graph.has(pid)) return;
      const b = approvedBom(db, pid, to),
        children = new Set<number>();
      graph.set(pid, children);
      if (b)
        for (const c of components(db, b, 1000)) {
          children.add(c.productId);
          graphFor(c.productId, new Set([...path, pid]));
        }
    }
    for (const o of orders) {
      const requiredDate = o.date < from ? from : o.date;
      const snapshot = db
        .prepare(
          `SELECT component_product_id AS productId,SUM(required_quantity) AS required,SUM(consumed_quantity) AS consumed
        FROM manufacturing_order_components WHERE mo_id=? GROUP BY component_product_id`,
        )
        .all(o.id) as { productId: number; required: number; consumed: number }[];
      const frozen = snapshot.length > 0 && !["planned", "confirmed"].includes(o.status);
      const b = approvedBom(db, o.product_id, requiredDate, o.bom_id);
      if (!frozen && !b)
        throw new PlanningError(`Order ${o.number} needs an approved, effective BOM.`);
      const needs = frozen
        ? snapshot.map((c) => ({
            productId: c.productId,
            quantity: c.required,
            consumed: c.consumed,
          }))
        : components(db, b!, Math.max(0, o.planned_quantity - o.actual_quantity)).map((c) => ({
            ...c,
            consumed: 0,
          }));
      for (const c of needs) {
        const issued = db
          .prepare(
            `SELECT COALESCE(SUM(CASE WHEN issue_type='issue' THEN quantity_milli WHEN issue_type='return' THEN -quantity_milli ELSE 0 END),0) AS qty
        FROM manufacturing_material_issues WHERE mo_id=? AND component_product_id=?`,
          )
          .get(o.id, c.productId) as { qty: number };
        graphFor(c.productId, new Set([o.product_id]));
        add(
          c.productId,
          requiredDate,
          Math.max(0, c.quantity - Math.max(c.consumed, issued.qty)),
          new Set([o.id]),
        );
      }
    }
    function visit(pid: number) {
      if (visiting.has(pid)) throw new PlanningError("A circular BOM prevents MRP calculation.");
      if (visited.has(pid)) return;
      visiting.add(pid);
      for (const c of graph.get(pid) ?? []) visit(c);
      visiting.delete(pid);
      visited.add(pid);
      ordered.push(pid);
    }
    for (const pid of graph.keys()) visit(pid);
    ordered.reverse();
    for (const pid of ordered) {
      product(db, pid);
      const rule = rules(db, pid, location),
        safety = rule?.safety_milli ?? 0,
        lead = rule?.lead_time_days ?? 0;
      const totalReserved = reservedQuantity(db, pid, location);
      const owned = orderIds.length
        ? (
            db
              .prepare(
                `SELECT COALESCE(SUM(quantity_milli),0) AS qty FROM ims_reservations WHERE product_id=? AND status='active'
        AND source_kind='manufacturingOrder' AND source_id IN (${orderIds.map(() => "?").join(",")}) AND (? IS NULL OR location_id IS NULL OR location_id=?)`,
              )
              .get(pid, ...orderIds, location, location) as { qty: number }
          ).qty
        : 0;
      let stock = Math.max(
        0,
        sellableOnHand(db, pid, location) - Math.max(0, totalReserved - owned),
      );
      const incoming = [
        ...supplies(db, pid, to, location),
        ...purchaseSupply(db, pid, location),
      ].sort((a, b) => a.date.localeCompare(b.date));
      const requests = requestedSupply(db, pid, location);
      for (const e of (events.get(pid) ?? []).sort((a, b) => a.date.localeCompare(b.date))) {
        const availableStock = stock,
          receipt = take(incoming, e.date);
        stock += receipt;
        const net = checkedQuantity(Math.max(0, e.qty + safety - stock)),
          requested = take(requests, e.date, net),
          suggested = net - requested;
        const b = approvedBom(db, pid, e.date),
          action = suggested === 0 ? "none" : b ? "manufacture" : "purchase",
          release = addDays(e.date, -lead);
        const sources = [...e.sources].sort((a, b) => a - b);
        db.prepare(
          `INSERT INTO manufacturing_mrp_requirements(mrp_run_id,product_id,gross_requirement,available_supply,net_requirement,shortage_qty,
          required_by_date,suggested_action,source_mo_id,created_at,scheduled_receipts,reserved_quantity,safety_stock,requested_supply,suggested_quantity,planned_release_date,source_mo_ids,bom_id)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          id,
          pid,
          e.qty,
          availableStock,
          net,
          net,
          e.date,
          action,
          sources.length === 1 ? sources[0] : null,
          now,
          receipt,
          Math.max(0, totalReserved - owned),
          safety,
          requested,
          suggested,
          release,
          JSON.stringify(sources),
          b?.id ?? null,
        );
        // Planned recommendations preserve safety stock for subsequent buckets; they are not posted inventory.
        stock = Math.max(safety, stock - e.qty);
        if (b && suggested > 0) {
          for (const c of components(db, b, suggested)) {
            if (!graph.has(c.productId))
              throw new PlanningError(
                "BOM revisions change within this horizon. Split the run at the revision boundary.",
              );
            add(c.productId, release, c.quantity, e.sources);
          }
        }
      }
    }
    const count = (
      db
        .prepare("SELECT COUNT(*) AS n FROM manufacturing_mrp_requirements WHERE mrp_run_id=?")
        .get(id) as { n: number }
    ).n;
    if (count === 0)
      db.prepare("UPDATE manufacturing_mrp_runs SET status='empty' WHERE id=?").run(id);
    if (count > 5000)
      throw new PlanningError(
        "This scope exceeds 5,000 component/date requirements. Split it into smaller MRP runs.",
      );
    db.prepare("UPDATE manufacturing_mrp_runs SET input_fingerprint=? WHERE id=?").run(
      fingerprint(db),
      id,
    );
    recordAudit(
      db,
      actor,
      {
        module: "manufacturing",
        action: "runMrp",
        entityType: "mrpRun",
        entityId: id,
        newValues: { orders: orderIds, requirements: count },
      },
      now,
    );
    return getMrpRun(db, id);
  })();
}
export function approveMrp(
  db: SqliteDatabase,
  id: number,
  actor: AuditActor,
  now: string,
): MrpRunDto {
  return db.transaction(() => {
    const r = getMrpRun(db, id);
    if (r.status === "approved") return r;
    if (r.status !== "completed")
      throw new PlanningError("Only a completed, current MRP run can be approved.");
    assertCurrent(db, id);
    db.prepare("UPDATE manufacturing_mrp_runs SET status='approved' WHERE id=?").run(id);
    recordAudit(
      db,
      actor,
      { module: "manufacturing", action: "approveMrp", entityType: "mrpRun", entityId: id },
      now,
    );
    return getMrpRun(db, id);
  })();
}
export function convertMrp(
  context: OperationContext,
  id: number,
  kind: "purchase" | "manufacture",
  requirementIds?: readonly number[],
): MrpRunDto {
  const { db, actor, nowIso: now } = context;
  return db.transaction(() => {
    const run = getMrpRun(db, id);
    if (run.status !== "approved")
      throw new PlanningError("Approve the current MRP run before generating supply.");
    assertCurrent(db, id);
    if (requirementIds?.some((id) => !run.requirements.some((r) => r.id === id)))
      throw new PlanningError("A suggestion does not belong to this run.");
    for (const r of run.requirements.filter(
      (r) =>
        r.suggestedAction === kind &&
        r.suggestedQuantity > 0 &&
        (!requirementIds || requirementIds.includes(r.id)),
    )) {
      if (r.requisitionId !== null || r.generatedMoId !== null) continue;
      if (kind === "purchase") {
        const p = product(db, r.productId),
          rule = rules(db, r.productId, run.locationId);
        const pr = saveOperation(context, {
          kind: "purchaseRequisition",
          partyId: rule?.preferred_supplier_id ?? null,
          fromLocationId: run.locationId,
          issueDate: context.nowDate,
          requiredDate: r.requiredByDate,
          reference: `MRP:${id}:requirement:${r.id}`,
          clientToken: `MRP:${id}:${r.id}`,
          notes: `Manufacturing demand: ${r.sourceMoNumber ?? r.sourceMoIds.join(", ")}. Required ${r.requiredByDate}.`,
          lines: [
            {
              productId: p.id,
              description: p.name,
              quantityMilli: r.suggestedQuantity,
              unitCostFils: p.average_cost_fils,
              unitPriceFils: p.average_cost_fils,
              vatTreatment: "standard",
            },
          ],
        });
        db.prepare("UPDATE manufacturing_mrp_requirements SET requisition_id=? WHERE id=?").run(
          pr.id,
          r.id,
        );
      } else {
        if (r.bomId === null)
          throw new PlanningError("An approved BOM is required to manufacture this component.");
        const mo = planningMo(
          db,
          actor,
          {
            productId: r.productId,
            bomId: r.bomId,
            quantity: r.suggestedQuantity,
            fromDate: r.plannedReleaseDate!,
            toDate: r.requiredByDate!,
            locationId: run.locationId,
            reference: `MRP:${id}:requirement:${r.id}`,
          },
          now,
        );
        db.prepare("UPDATE manufacturing_mrp_requirements SET generated_mo_id=? WHERE id=?").run(
          mo,
          r.id,
        );
      }
    }
    db.prepare("UPDATE manufacturing_mrp_runs SET input_fingerprint=? WHERE id=?").run(
      fingerprint(db),
      id,
    );
    recordAudit(
      db,
      actor,
      {
        module: "manufacturing",
        action: kind === "purchase" ? "generateRequisitions" : "generateSubassemblies",
        entityType: "mrpRun",
        entityId: id,
      },
      now,
    );
    return getMrpRun(db, id);
  })();
}
