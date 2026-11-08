/**
 * Manufacturing costing repository.
 *
 * Calculates real manufacturing cost per order:
 *   Raw Material Cost + Direct Labor + Machine/Work Center + Overhead +
 *   Subcontracting + Rework + Scrap
 *
 * Planned cost comes from the BOM snapshot at MO creation. Actual cost is
 * accumulated from consumption records, time logs, work center rates, and
 * scrap records. Unit cost = total actual cost / accepted quantity.
 *
 * This records manufacturing operational costs and WIP valuation details.
 * Official GL/journal posting is owned by the future ERP module; MMS does
 * not fabricate journal entries.
 */

import type { SqliteDatabase } from "../../../data/connection";
import type {
  CostRecordDto,
  MoCostListRequest,
  MoCostSummaryDto,
  SaveCostRecordRequest,
} from "../../../shared/types";
import type { AuditActor } from "../../audit-writer";
import { recordAudit } from "../../audit-writer";

export class CostingError extends Error {
  public constructor(message: string, public readonly field?: string) {
    super(message);
    this.name = "CostingError";
  }
}

interface CostRecordRow {
  readonly id: number;
  readonly mo_id: number;
  readonly cost_type: string;
  readonly amount_fils: number;
  readonly quantity_basis: number | null;
  readonly recorded_at: string;
  readonly recorded_by: string | null;
  readonly notes: string | null;
  readonly mo_number: string;
}

function mapCostRecord(row: CostRecordRow): CostRecordDto {
  return {
    id: row.id,
    moId: row.mo_id,
    moNumber: row.mo_number,
    costType: row.cost_type as CostRecordDto["costType"],
    amountFils: row.amount_fils,
    quantityBasis: row.quantity_basis,
    recordedAt: row.recorded_at,
    recordedBy: row.recorded_by,
    notes: row.notes,
  };
}

export function listCostRecords(
  db: SqliteDatabase,
  request: MoCostListRequest,
): CostRecordDto[] {
  const clauses: string[] = ["1 = 1"];
  const params: (string | number)[] = [];

  if (request.moId !== undefined) {
    clauses.push("cr.mo_id = ?");
    params.push(request.moId);
  }
  if (request.productId !== undefined) {
    clauses.push("mo.product_id = ?");
    params.push(request.productId);
  }

  const where = ` WHERE ${clauses.join(" AND ")}`;
  const limit = request.limit ?? 500;

  const rows = db
    .prepare(
      `SELECT cr.*, mo.number AS mo_number
         FROM manufacturing_cost_records cr
         JOIN manufacturing_orders mo ON mo.id = cr.mo_id
        ${where}
        ORDER BY cr.recorded_at DESC
        LIMIT ?`,
    )
    .all(...params, limit) as CostRecordRow[];

  return rows.map(mapCostRecord);
}

export function saveCostRecord(
  db: SqliteDatabase,
  actor: AuditActor,
  input: SaveCostRecordRequest,
  nowIso: string,
): CostRecordDto {
  return db.transaction((): CostRecordDto => {
    const mo = db
      .prepare("SELECT number FROM manufacturing_orders WHERE id = ?")
      .get(input.moId) as { number: string } | undefined;
    if (mo === undefined) throw new CostingError("The manufacturing order was not found.");

    const info = db
      .prepare(
        `INSERT INTO manufacturing_cost_records
           (mo_id, cost_type, amount_fils, quantity_basis, recorded_at, recorded_by, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.moId,
        input.costType,
        input.amountFils,
        input.quantityBasis ?? null,
        nowIso,
        actor.name,
        input.notes ?? null,
      );

    const id = Number(info.lastInsertRowid);

    // Update MO actual cost.
    db.prepare(
      `UPDATE manufacturing_orders
          SET actual_cost_fils = actual_cost_fils + ?, updated_at = ?
        WHERE id = ?`,
    ).run(input.amountFils, nowIso, input.moId);

    recordAudit(
      db,
      actor,
      {
        module: "manufacturing",
        action: "recordCost",
        entityType: "costRecord",
        entityId: id,
        newValues: { moId: input.moId, costType: input.costType, amountFils: input.amountFils },
      },
      nowIso,
    );

    const row = db
      .prepare("SELECT *, mo.number AS mo_number FROM manufacturing_cost_records cr JOIN manufacturing_orders mo ON mo.id = cr.mo_id WHERE cr.id = ?")
      .get(id) as CostRecordRow | undefined;
    if (row === undefined) throw new CostingError("The cost record could not be read back.");
    return mapCostRecord(row);
  })();
}

export function getMoCostSummary(
  db: SqliteDatabase,
  moId: number,
): MoCostSummaryDto {
  const mo = db
    .prepare(
      `SELECT mo.id, mo.number, mo.planned_quantity, mo.accepted_quantity,
              p.name AS product_name, mo.planned_cost_fils, mo.actual_cost_fils
         FROM manufacturing_orders mo
         JOIN products p ON p.id = mo.product_id
        WHERE mo.id = ?`,
    )
    .get(moId) as {
    id: number;
    number: string;
    planned_quantity: number;
    accepted_quantity: number;
    product_name: string;
    planned_cost_fils: number;
    actual_cost_fils: number;
  } | undefined;
  if (mo === undefined) throw new CostingError(`Manufacturing order ${String(moId)} was not found.`);

  const costByType = db
    .prepare(
      `SELECT cost_type, COALESCE(SUM(amount_fils), 0) AS total
         FROM manufacturing_cost_records
        WHERE mo_id = ?
        GROUP BY cost_type`,
    )
    .all(moId) as { cost_type: string; total: number }[];

  const byType = new Map<string, number>();
  for (const row of costByType) {
    byType.set(row.cost_type, row.total);
  }

  const materialCost = byType.get("material") ?? 0;
  const laborCost = byType.get("labor") ?? 0;
  const machineCost = byType.get("machine") ?? 0;
  const overheadCost = byType.get("overhead") ?? 0;
  const subcontractCost = byType.get("subcontract") ?? 0;
  const reworkCost = byType.get("rework") ?? 0;
  const scrapCost = byType.get("scrap") ?? 0;

  const totalCostFils =
    materialCost + laborCost + machineCost + overheadCost + subcontractCost + reworkCost + scrapCost;
  const unitCostFils = mo.accepted_quantity > 0 ? Math.round(totalCostFils / (mo.accepted_quantity / 1000)) : 0;
  const costVarianceFils = totalCostFils - mo.planned_cost_fils;

  return {
    moId: mo.id,
    moNumber: mo.number,
    productName: mo.product_name,
    plannedQuantity: mo.planned_quantity,
    acceptedQuantity: mo.accepted_quantity,
    materialCostFils: materialCost,
    laborCostFils: laborCost,
    machineCostFils: machineCost,
    overheadCostFils: overheadCost,
    subcontractCostFils: subcontractCost,
    reworkCostFils: reworkCost,
    scrapCostFils: scrapCost,
    totalCostFils,
    unitCostFils,
    plannedCostFils: mo.planned_cost_fils,
    costVarianceFils,
  };
}
