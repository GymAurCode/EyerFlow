/**
 * Scrap management repository.
 *
 * Real write path for production scrap: quantity against a manufacturing
 * order, typed (material / process / finished-product) with a reason and the
 * work center it came from. The cost is derived server-side from the product's
 * average cost at write time — never from a client-supplied figure — and the
 * row links the consumption/ledger trail through `cost_fils` only; the cost
 * engine may later turn scrap rows into scrap cost records.
 */

import type { SqliteDatabase } from "../../../data/connection";
import type { ScrapDto, ScrapListRequest, SaveScrapRequest } from "../../../shared/types";
import type { AuditActor } from "../../audit-writer";
import { recordAudit } from "../../audit-writer";

export class ScrapError extends Error {
  public constructor(message: string, public readonly field?: string) {
    super(message);
    this.name = "ScrapError";
  }
}

interface ScrapRow {
  readonly id: number;
  readonly mo_id: number;
  readonly work_order_id: number | null;
  readonly product_id: number;
  readonly quantity_milli: number;
  readonly scrap_type: string;
  readonly scrap_reason: string | null;
  readonly cost_fils: number;
  readonly work_center_id: number | null;
  readonly stock_movement_id: number | null;
  readonly created_at: string;
  readonly created_by: string | null;
  readonly mo_number: string;
  readonly product_sku: string;
  readonly product_name: string;
  readonly work_center_name: string | null;
}

const LIST_SELECT = `
  SELECT s.*, mo.number AS mo_number,
         p.sku AS product_sku, p.name AS product_name,
         w.name AS work_center_name
    FROM manufacturing_scrap s
    JOIN manufacturing_orders mo ON mo.id = s.mo_id
    JOIN products p ON p.id = s.product_id
    LEFT JOIN manufacturing_work_centers w ON w.id = s.work_center_id`;

function mapScrap(row: ScrapRow): ScrapDto {
  return {
    id: row.id,
    moId: row.mo_id,
    moNumber: row.mo_number,
    workOrderId: row.work_order_id,
    productId: row.product_id,
    productSku: row.product_sku,
    productName: row.product_name,
    quantityMilli: row.quantity_milli,
    scrapType: row.scrap_type as ScrapDto["scrapType"],
    scrapReason: row.scrap_reason,
    costFils: row.cost_fils,
    workCenterId: row.work_center_id,
    workCenterName: row.work_center_name,
    stockMovementId: row.stock_movement_id,
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

export function listScrapRecords(
  db: SqliteDatabase,
  request: ScrapListRequest,
): ScrapDto[] {
  const clauses: string[] = ["1 = 1"];
  const params: (string | number)[] = [];

  if (request.moId !== undefined) {
    clauses.push("s.mo_id = ?");
    params.push(request.moId);
  }
  if (request.productId !== undefined) {
    clauses.push("s.product_id = ?");
    params.push(request.productId);
  }
  if (request.scrapType !== undefined) {
    clauses.push("s.scrap_type = ?");
    params.push(request.scrapType);
  }

  const where = ` WHERE ${clauses.join(" AND ")}`;
  const limit = request.limit ?? 500;

  const rows = db
    .prepare(`${LIST_SELECT}${where} ORDER BY s.created_at DESC, s.id DESC LIMIT ?`)
    .all(...params, limit) as ScrapRow[];

  return rows.map(mapScrap);
}

export function saveScrapRecord(
  db: SqliteDatabase,
  actor: AuditActor,
  input: SaveScrapRequest,
  nowIso: string,
): ScrapDto {
  return db.transaction((): ScrapDto => {
    const mo = db
      .prepare("SELECT id, number FROM manufacturing_orders WHERE id = ?")
      .get(input.moId) as { id: number; number: string } | undefined;
    if (mo === undefined) {
      throw new ScrapError("The manufacturing order was not found.", "moId");
    }

    const product = db
      .prepare("SELECT id, average_cost_fils FROM products WHERE id = ?")
      .get(input.productId) as { id: number; average_cost_fils: number } | undefined;
    if (product === undefined) {
      throw new ScrapError("The scrapped product was not found.", "productId");
    }

    if (input.quantityMilli <= 0) {
      throw new ScrapError("Scrap quantity must be greater than zero.", "quantityMilli");
    }

    const costFils = Math.round((product.average_cost_fils * input.quantityMilli) / 1000);

    const info = db
      .prepare(
        `INSERT INTO manufacturing_scrap
           (mo_id, work_order_id, product_id, quantity_milli, scrap_type, scrap_reason,
            cost_fils, work_center_id, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.moId,
        input.workOrderId ?? null,
        input.productId,
        input.quantityMilli,
        input.scrapType ?? "material",
        input.scrapReason ?? null,
        costFils,
        input.workCenterId ?? null,
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
        entityType: "scrap",
        entityId: id,
        newValues: { ...input, costFils },
      },
      nowIso,
    );

    const row = db.prepare(`${LIST_SELECT} WHERE s.id = ?`).get(id) as
      | ScrapRow
      | undefined;
    if (row === undefined) throw new ScrapError("The scrap record could not be read back.");
    return mapScrap(row);
  })();
}
