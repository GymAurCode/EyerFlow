/**
 * Finished goods receipt repository.
 *
 * When a manufacturing order produces accepted output, the finished goods
 * are received through this controlled workflow:
 *   1. Select MO and review produced/accepted quantity.
 *   2. Validate QC (if required by config).
 *   3. Assign finished goods location and lot/serial.
 *   4. Calculate attributable manufacturing cost.
 *   5. Post exactly one finished-stock movement through the IMS stock engine.
 *   6. IMS immediately shows the finished SKU, quantity, location, batch, cost.
 *
 * Idempotency keys prevent duplicate receipts on retry. Rejected output never
 * becomes sellable stock.
 */

import type { SqliteDatabase } from "../../../data/connection";
import type {
  FinishedReceiptDto,
  FinishedReceiptListRequest,
  SaveFinishedReceiptRequest,
} from "../../../shared/types";
import type { AuditActor } from "../../audit-writer";
import { recordAudit } from "../../audit-writer";
import {
  defaultLocationId,
  postMovement,
  type StockContext,
} from "../ims/stock";
import { readConfig } from "./config";

export class FinishedReceiptError extends Error {
  public constructor(message: string, public readonly field?: string) {
    super(message);
    this.name = "FinishedReceiptError";
  }
}

interface FinishedReceiptRow {
  readonly id: number;
  readonly mo_id: number;
  readonly work_order_id: number | null;
  readonly product_id: number;
  readonly quantity_milli: number;
  readonly accepted_qty: number;
  readonly rejected_qty: number;
  readonly batch_no: string | null;
  readonly serial_no: string | null;
  readonly location_id: number | null;
  readonly unit_cost_fils: number;
  readonly total_cost_fils: number;
  readonly stock_movement_id: number | null;
  readonly idempotency_key: string | null;
  readonly received_at: string;
  readonly received_by: string | null;
  readonly notes: string | null;
  readonly mo_number: string;
  readonly product_sku: string;
  readonly product_name: string;
}

function mapFinishedReceipt(row: FinishedReceiptRow): FinishedReceiptDto {
  return {
    id: row.id,
    moId: row.mo_id,
    moNumber: row.mo_number,
    workOrderId: row.work_order_id,
    productId: row.product_id,
    productSku: row.product_sku,
    productName: row.product_name,
    quantityMilli: row.quantity_milli,
    acceptedQty: row.accepted_qty,
    rejectedQty: row.rejected_qty,
    batchNo: row.batch_no,
    serialNo: row.serial_no,
    locationId: row.location_id,
    unitCostFils: row.unit_cost_fils,
    totalCostFils: row.total_cost_fils,
    stockMovementId: row.stock_movement_id,
    idempotencyKey: row.idempotency_key,
    receivedAt: row.received_at,
    receivedBy: row.received_by,
    notes: row.notes,
  };
}

function stockContext(db: SqliteDatabase, actorName: string, nowIso: string): StockContext {
  return {
    db,
    actorName,
    nowIso,
    nowDate: nowIso.slice(0, 10),
    allowNegativeStock: false,
  };
}

export function listFinishedReceipts(
  db: SqliteDatabase,
  request: FinishedReceiptListRequest,
): FinishedReceiptDto[] {
  const clauses: string[] = ["1 = 1"];
  const params: (string | number)[] = [];

  if (request.moId !== undefined) {
    clauses.push("fr.mo_id = ?");
    params.push(request.moId);
  }
  if (request.productId !== undefined) {
    clauses.push("fr.product_id = ?");
    params.push(request.productId);
  }

  const where = ` WHERE ${clauses.join(" AND ")}`;
  const limit = request.limit ?? 500;

  const rows = db
    .prepare(
      `SELECT fr.*, mo.number AS mo_number, p.sku AS product_sku, p.name AS product_name
         FROM manufacturing_finished_receipts fr
         JOIN manufacturing_orders mo ON mo.id = fr.mo_id
         JOIN products p ON p.id = fr.product_id
        ${where}
        ORDER BY fr.received_at DESC
        LIMIT ?`,
    )
    .all(...params, limit) as FinishedReceiptRow[];

  return rows.map(mapFinishedReceipt);
}

export function getFinishedReceipt(
  db: SqliteDatabase,
  id: number,
): FinishedReceiptDto {
  const row = db
    .prepare(
      `SELECT fr.*, mo.number AS mo_number, p.sku AS product_sku, p.name AS product_name
         FROM manufacturing_finished_receipts fr
         JOIN manufacturing_orders mo ON mo.id = fr.mo_id
         JOIN products p ON p.id = fr.product_id
        WHERE fr.id = ?`,
    )
    .get(id) as FinishedReceiptRow | undefined;
  if (row === undefined)
    throw new FinishedReceiptError(`Finished receipt ${String(id)} was not found.`);

  return mapFinishedReceipt(row);
}

export function saveFinishedReceipt(
  db: SqliteDatabase,
  actor: AuditActor,
  input: SaveFinishedReceiptRequest,
  nowIso: string,
): FinishedReceiptDto {
  return db.transaction((): FinishedReceiptDto => {
    const mo = db
      .prepare(
        `SELECT mo.number, mo.status, mo.accepted_quantity, mo.rejected_quantity, mo.actual_quantity,
                p.id AS product_id, p.sku AS product_sku, p.name AS product_name, p.average_cost_fils
           FROM manufacturing_orders mo
           JOIN products p ON p.id = mo.product_id
          WHERE mo.id = ?`,
      )
      .get(input.moId) as {
      number: string;
      status: string;
      accepted_quantity: number;
      rejected_quantity: number;
      actual_quantity: number;
      product_id: number;
      product_sku: string;
      product_name: string;
      average_cost_fils: number;
    } | undefined;
    if (mo === undefined) throw new FinishedReceiptError("The manufacturing order was not found.");
    if (mo.status !== "qualityReview" && mo.status !== "inProgress" && mo.status !== "completed") {
      throw new FinishedReceiptError(
        `Finished goods can only be received from an MO in quality review or completed. Current: ${mo.status}.`,
      );
    }

    // Enforce "Require quality check before receipt" policy.
    const config = readConfig(db);
    if (config.requireQCBeforeReceipt) {
      const checks = db
        .prepare(
          `SELECT COUNT(*) AS cnt FROM manufacturing_quality_checks
            WHERE mo_id = ? AND result IN ('passed', 'released')`,
        )
        .get(input.moId) as { cnt: number };
      const rejected = db
        .prepare(
          `SELECT COUNT(*) AS cnt FROM manufacturing_quality_checks
            WHERE mo_id = ? AND result IN ('failed', 'rejected', 'reworkRequired')`,
        )
        .get(input.moId) as { cnt: number };
      if ((checks?.cnt ?? 0) === 0) {
        throw new FinishedReceiptError(
          "A quality check must be passed before finished goods can be received.",
          "moId",
        );
      }
      if ((rejected?.cnt ?? 0) > 0) {
        throw new FinishedReceiptError(
          "Failed quality checks prevent receiving finished goods; resolve the inspection first.",
          "moId",
        );
      }
    }

    const idempotencyKey =
      input.idempotencyKey ?? `receipt:${input.moId}:${nowIso}`;

    // Idempotency: return existing receipt on retry.
    const existing = db
      .prepare("SELECT id FROM manufacturing_finished_receipts WHERE idempotency_key = ?")
      .get(idempotencyKey) as { id: number } | undefined;
    if (existing !== undefined) {
      const row = db
        .prepare(
          `SELECT fr.*, mo.number AS mo_number, p.sku AS product_sku, p.name AS product_name
             FROM manufacturing_finished_receipts fr
             JOIN manufacturing_orders mo ON mo.id = fr.mo_id
             JOIN products p ON p.id = fr.product_id
            WHERE fr.id = ?`,
        )
        .get(existing.id) as FinishedReceiptRow | undefined;
      if (row !== undefined) return mapFinishedReceipt(row);
    }

    // Prevent receiving more than produced.
    const alreadyReceived = db
      .prepare(
        `SELECT COALESCE(SUM(accepted_qty), 0) AS total FROM manufacturing_finished_receipts
          WHERE mo_id = ?`,
      )
      .get(input.moId) as { total: number };

    const remainingToAccept = mo.actual_quantity - (alreadyReceived.total ?? 0);
    if (input.quantityMilli > remainingToAccept) {
      throw new FinishedReceiptError(
        `Cannot accept ${String(Math.round(input.quantityMilli / 1000))} units: only ${String(
          Math.round(remainingToAccept / 1000),
        )} produced units remain un-received.`,
      );
    }

    const ctx = stockContext(db, actor.name, nowIso);
    const locationId = input.locationId ?? defaultLocationId(db);
    const costRow = db
      .prepare("SELECT average_cost_fils FROM products WHERE id = ?")
      .get(mo.product_id) as { average_cost_fils: number } | undefined;
    const unitCost = costRow?.average_cost_fils ?? 0;
    const totalCost = Math.round((input.quantityMilli * unitCost) / 1000);

    // Post exactly one finished-stock receipt movement (affects product total).
    const movement = postMovement(ctx, {
      productId: mo.product_id,
      locationId,
      movementDate: nowIso.slice(0, 10),
      kind: "receipt",
      quantityMilli: input.quantityMilli,
      unitCostFils: unitCost,
      stockStatus: "available",
      sourceKind: "manufacturingOrder",
      sourceId: input.moId,
      notes: `Finished goods receipt for ${mo.number}`,
      affectProductTotal: true,
      idempotencyKey: `${idempotencyKey}:stock`,
      allowNegativeOverride: false,
    });

    const info = db
      .prepare(
        // One placeholder per column, including accepted/rejected quantity.
        // The earlier form used two inline zeros for those two columns, which
        // shifted every following value by one and put the batch number into
        // `accepted_qty` - a NOT NULL column - so no receipt could be saved.
        `INSERT INTO manufacturing_finished_receipts
           (mo_id, work_order_id, product_id, quantity_milli, accepted_qty, rejected_qty,
            batch_no, serial_no, location_id, unit_cost_fils, total_cost_fils,
            stock_movement_id, idempotency_key, received_at, received_by, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.moId,
        input.workOrderId ?? null,
        mo.product_id,
        input.quantityMilli,
        input.quantityMilli,
        0,
        input.batchNo ?? null,
        input.serialNo ?? null,
        locationId,
        unitCost,
        totalCost,
        movement.id,
        idempotencyKey,
        nowIso.slice(0, 10),
        actor.name,
        input.notes ?? null,
      );

    const id = Number(info.lastInsertRowid);

    // Update MO accepted quantity.
    db.prepare(
      `UPDATE manufacturing_orders
          SET accepted_quantity = accepted_quantity + ?,
              updated_at = ?
        WHERE id = ?`,
    ).run(input.quantityMilli, nowIso, input.moId);

    recordAudit(
      db,
      actor,
      {
        module: "manufacturing",
        action: "receiveFinishedGoods",
        entityType: "finishedReceipt",
        entityId: id,
        newValues: {
          moId: input.moId,
          productId: mo.product_id,
          quantityMilli: input.quantityMilli,
          totalCostFils: totalCost,
        },
      },
      nowIso,
    );

    const row = db
      .prepare(
        `SELECT fr.*, mo.number AS mo_number, p.sku AS product_sku, p.name AS product_name
           FROM manufacturing_finished_receipts fr
           JOIN manufacturing_orders mo ON mo.id = fr.mo_id
           JOIN products p ON p.id = fr.product_id
          WHERE fr.id = ?`,
      )
      .get(id) as FinishedReceiptRow | undefined;
    if (row === undefined)
      throw new FinishedReceiptError("The finished receipt could not be read back.");
    return mapFinishedReceipt(row);
  })();
}
