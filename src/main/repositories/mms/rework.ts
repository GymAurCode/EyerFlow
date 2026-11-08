/**
 * Rework management repository.
 *
 * Real rework orders linked to a manufacturing order: a quantity sent back
 * through a production operation, with extra material and labor cost, and a
 * reinspection gate before release.
 */

import type { SqliteDatabase } from "../../../data/connection";
import type { ReworkDto, ReworkListRequest, SaveReworkRequest } from "../../../shared/types";
import type { AuditActor } from "../../audit-writer";
import { recordAudit } from "../../audit-writer";

export class ReworkError extends Error {
  public constructor(message: string, public readonly field?: string) {
    super(message);
    this.name = "ReworkError";
  }
}

interface ReworkRow {
  readonly id: number;
  readonly mo_id: number;
  readonly work_order_id: number | null;
  readonly output_product_id: number;
  readonly quantity_milli: number;
  readonly reason: string | null;
  readonly extra_material_cost_fils: number;
  readonly extra_labor_cost_fils: number;
  readonly status: string;
  readonly reinspection_result: string | null;
  readonly created_at: string;
  readonly created_by: string | null;
  readonly mo_number: string;
  readonly product_sku: string;
  readonly product_name: string;
}

const LIST_SELECT = `
  SELECT r.*, mo.number AS mo_number,
         p.sku AS product_sku, p.name AS product_name
    FROM manufacturing_rework r
    JOIN manufacturing_orders mo ON mo.id = r.mo_id
    JOIN products p ON p.id = r.output_product_id`;

function mapRework(row: ReworkRow): ReworkDto {
  return {
    id: row.id,
    moId: row.mo_id,
    moNumber: row.mo_number,
    workOrderId: row.work_order_id,
    outputProductId: row.output_product_id,
    outputProductSku: row.product_sku,
    outputProductName: row.product_name,
    quantityMilli: row.quantity_milli,
    reason: row.reason,
    extraMaterialCostFils: row.extra_material_cost_fils,
    extraLaborCostFils: row.extra_labor_cost_fils,
    status: row.status,
    reinspectionResult: row.reinspection_result,
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

export function listReworkRecords(
  db: SqliteDatabase,
  request: ReworkListRequest,
): ReworkDto[] {
  const clauses: string[] = ["1 = 1"];
  const params: (string | number)[] = [];

  if (request.moId !== undefined) {
    clauses.push("r.mo_id = ?");
    params.push(request.moId);
  }
  if (request.status !== undefined) {
    clauses.push("r.status = ?");
    params.push(request.status);
  }

  const where = ` WHERE ${clauses.join(" AND ")}`;
  const limit = request.limit ?? 500;

  const rows = db
    .prepare(`${LIST_SELECT}${where} ORDER BY r.created_at DESC, r.id DESC LIMIT ?`)
    .all(...params, limit) as ReworkRow[];

  return rows.map(mapRework);
}

export function saveReworkRecord(
  db: SqliteDatabase,
  actor: AuditActor,
  input: SaveReworkRequest,
  nowIso: string,
): ReworkDto {
  return db.transaction((): ReworkDto => {
    const mo = db
      .prepare("SELECT id, number FROM manufacturing_orders WHERE id = ?")
      .get(input.moId) as { id: number; number: string } | undefined;
    if (mo === undefined) {
      throw new ReworkError("The manufacturing order was not found.", "moId");
    }

    const product = db
      .prepare("SELECT id FROM products WHERE id = ?")
      .get(input.outputProductId) as { id: number } | undefined;
    if (product === undefined) {
      throw new ReworkError("The rework output product was not found.", "outputProductId");
    }

    if (input.quantityMilli <= 0) {
      throw new ReworkError("Rework quantity must be greater than zero.", "quantityMilli");
    }

    const info = db
      .prepare(
        `INSERT INTO manufacturing_rework
           (mo_id, work_order_id, output_product_id, quantity_milli, reason,
            extra_material_cost_fils, extra_labor_cost_fils, status,
            reinspection_result, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.moId,
        input.workOrderId ?? null,
        input.outputProductId,
        input.quantityMilli,
        input.reason ?? null,
        input.extraMaterialCostFils ?? 0,
        input.extraLaborCostFils ?? 0,
        input.status ?? "requested",
        input.reinspectionResult ?? null,
        nowIso,
        actor.name,
      );

    const id = Number(info.lastInsertRowid);

    recordAudit(
      db,
      actor,
      {
        module: "manufacturing",
        action: "create",
        entityType: "rework",
        entityId: id,
        newValues: input,
      },
      nowIso,
    );

    const row = db.prepare(`${LIST_SELECT} WHERE r.id = ?`).get(id) as
      | ReworkRow
      | undefined;
    if (row === undefined) throw new ReworkError("The rework record could not be read back.");
    return mapRework(row);
  })();
}
