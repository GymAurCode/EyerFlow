/**
 * Material issue & consumption repository.
 *
 * Material flows in manufacturing:
 *   reservation  → stock is promised, on-hand unchanged, available ↓
 *   issue        → stock moves from storage to WIP location (location transfer, total unchanged)
 *   consumption  → stock removed from WIP exactly once, cost moves into WIP
 *   return       → unconsumed stock returned from WIP to storage
 *
 * Every movement posts through the existing IMS stock engine
 * (`postMovement`, `reserveStock`, `releaseReservations`) so there is one
 * authoritative ledger shared with IMS. Idempotency keys prevent double
 * consumption on retry.
 */

import type { SqliteDatabase } from "../../../data/connection";
import type { ImsDocumentKind } from "../../../shared/ims";
import type {
  ConsumptionRecordDto,
  MaterialIssueDto,
  MaterialIssueListRequest,
  SaveConsumptionRecordRequest,
  SaveMaterialIssueRequest,
} from "../../../shared/types";
import type { AuditActor } from "../../audit-writer";
import { recordAudit } from "../../audit-writer";
import {
  availableQuantity,
  defaultLocationId,
  postMovement,
  releaseReservations,
  reserveStock,
  type StockContext,
} from "../ims/stock";

export class MaterialIssueError extends Error {
  public constructor(message: string, public readonly field?: string) {
    super(message);
    this.name = "MaterialIssueError";
  }
}

interface MaterialIssueRow {
  readonly id: number;
  readonly mo_id: number;
  readonly work_order_id: number | null;
  readonly component_product_id: number;
  readonly quantity_milli: number;
  readonly unit: string;
  readonly issue_type: string;
  readonly from_location_id: number | null;
  readonly to_location_id: number | null;
  readonly stock_movement_id: number | null;
  readonly idempotency_key: string | null;
  readonly created_at: string;
  readonly created_by: string | null;
  readonly mo_number: string;
  readonly component_sku: string;
  readonly component_name: string;
}

interface ConsumptionRecordRow {
  readonly id: number;
  readonly mo_id: number;
  readonly work_order_id: number | null;
  readonly component_product_id: number;
  readonly quantity_milli: number;
  readonly unit_cost_fils: number;
  readonly cost_fils: number;
  readonly stock_movement_id: number | null;
  readonly batch_no: string | null;
  readonly serial_no: string | null;
  readonly consumed_at: string;
  readonly consumed_by: string | null;
  readonly notes: string | null;
  readonly mo_number: string;
  readonly component_sku: string;
  readonly component_name: string;
}

function mapMaterialIssue(row: MaterialIssueRow): MaterialIssueDto {
  return {
    id: row.id,
    moId: row.mo_id,
    moNumber: row.mo_number,
    workOrderId: row.work_order_id,
    componentProductId: row.component_product_id,
    componentSku: row.component_sku,
    componentName: row.component_name,
    quantityMilli: row.quantity_milli,
    unit: row.unit,
    issueType: row.issue_type as MaterialIssueDto["issueType"],
    fromLocationId: row.from_location_id,
    toLocationId: row.to_location_id,
    stockMovementId: row.stock_movement_id,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

function mapConsumptionRecord(row: ConsumptionRecordRow): ConsumptionRecordDto {
  return {
    id: row.id,
    moId: row.mo_id,
    moNumber: row.mo_number,
    workOrderId: row.work_order_id,
    componentProductId: row.component_product_id,
    componentSku: row.component_sku,
    componentName: row.component_name,
    quantityMilli: row.quantity_milli,
    unitCostFils: row.unit_cost_fils,
    costFils: row.cost_fils,
    stockMovementId: row.stock_movement_id,
    batchNo: row.batch_no,
    serialNo: row.serial_no,
    consumedAt: row.consumed_at,
    consumedBy: row.consumed_by,
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

export function listMaterialIssues(
  db: SqliteDatabase,
  request: MaterialIssueListRequest,
): MaterialIssueDto[] {
  const clauses: string[] = ["1 = 1"];
  const params: (string | number)[] = [];

  if (request.moId !== undefined) {
    clauses.push("mi.mo_id = ?");
    params.push(request.moId);
  }
  if (request.workOrderId !== undefined) {
    clauses.push("mi.work_order_id = ?");
    params.push(request.workOrderId);
  }
  if (request.productId !== undefined) {
    clauses.push("mi.component_product_id = ?");
    params.push(request.productId);
  }
  if (request.issueType !== undefined) {
    clauses.push("mi.issue_type = ?");
    params.push(request.issueType);
  }

  const where = ` WHERE ${clauses.join(" AND ")}`;
  const limit = request.limit ?? 500;

  const rows = db
    .prepare(
      `SELECT mi.*, mo.number AS mo_number, p.sku AS component_sku, p.name AS component_name
         FROM manufacturing_material_issues mi
         JOIN manufacturing_orders mo ON mo.id = mi.mo_id
         JOIN products p ON p.id = mi.component_product_id
        ${where}
        ORDER BY mi.created_at DESC
        LIMIT ?`,
    )
    .all(...params, limit) as MaterialIssueRow[];

  return rows.map(mapMaterialIssue);
}

export function reserveMaterial(
  db: SqliteDatabase,
  actor: AuditActor,
  input: SaveMaterialIssueRequest,
  nowIso: string,
): MaterialIssueDto {
  return db.transaction((): MaterialIssueDto => {
    const mo = db
      .prepare("SELECT number, status FROM manufacturing_orders WHERE id = ?")
      .get(input.moId) as { number: string; status: string } | undefined;
    if (mo === undefined) throw new MaterialIssueError("The manufacturing order was not found.");
    if (mo.status !== "released" && mo.status !== "inProgress") {
      throw new MaterialIssueError(
        `Materials can only be reserved for a released or in-progress MO. Current: ${mo.status}.`,
      );
    }

    const idempotencyKey =
      input.idempotencyKey ?? `res:${input.moId}:${input.componentProductId}:${nowIso}`;

    // Idempotency: return the existing reservation if this key was already used.
    const existing = db
      .prepare("SELECT id FROM manufacturing_material_issues WHERE idempotency_key = ?")
      .get(idempotencyKey) as { id: number } | undefined;
    if (existing !== undefined) {
      const row = db
        .prepare(
          `SELECT mi.*, mo.number AS mo_number, p.sku AS component_sku, p.name AS component_name
             FROM manufacturing_material_issues mi
             JOIN manufacturing_orders mo ON mo.id = mi.mo_id
             JOIN products p ON p.id = mi.component_product_id
            WHERE mi.id = ?`,
        )
        .get(existing.id) as MaterialIssueRow | undefined;
      if (row !== undefined) return mapMaterialIssue(row);
    }

    // Check available stock through IMS engine.
    const available = availableQuantity(db, input.componentProductId);
    if (available < input.quantityMilli) {
      throw new MaterialIssueError(
        `Not enough available stock for this component. Available: ${String(
          Math.round(available / 1000),
        )}, requested: ${String(Math.round(input.quantityMilli / 1000))}.`,
      );
    }

    const ctx = stockContext(db, actor.name, nowIso);

    // Reserve through IMS stock engine (no stock movement, just a reservation row).
    reserveStock(
      db,
      actor.name,
      {
        productId: input.componentProductId,
        locationId: input.fromLocationId ?? defaultLocationId(db),
        quantityMilli: input.quantityMilli,
        sourceKind: "manufacturingOrder" as ImsDocumentKind,
        sourceId: input.moId,
        notes: `Reserved for ${mo.number}`,
      },
      nowIso,
    );

    const info = db
      .prepare(
        `INSERT INTO manufacturing_material_issues
           (mo_id, work_order_id, component_product_id, quantity_milli, unit,
            issue_type, from_location_id, to_location_id, idempotency_key, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, 'reservation', ?, ?, ?, ?, ?)`,
      )
      .run(
        input.moId,
        input.workOrderId ?? null,
        input.componentProductId,
        input.quantityMilli,
        "pcs",
        input.fromLocationId ?? null,
        null,
        idempotencyKey,
        nowIso,
        actor.name,
      );

    const id = Number(info.lastInsertRowid);

    recordAudit(
      db,
      actor,
      {
        module: "manufacturing",
        action: "reserveMaterial",
        entityType: "materialIssue",
        entityId: id,
        newValues: { moId: input.moId, componentProductId: input.componentProductId, quantityMilli: input.quantityMilli },
      },
      nowIso,
    );

    const row = db
      .prepare(
        `SELECT mi.*, mo.number AS mo_number, p.sku AS component_sku, p.name AS component_name
           FROM manufacturing_material_issues mi
           JOIN manufacturing_orders mo ON mo.id = mi.mo_id
           JOIN products p ON p.id = mi.component_product_id
          WHERE mi.id = ?`,
      )
      .get(id) as MaterialIssueRow | undefined;
    if (row === undefined) throw new MaterialIssueError("The reservation could not be read back.");
    return mapMaterialIssue(row);
  })();
}

export function issueMaterialToWip(
  db: SqliteDatabase,
  actor: AuditActor,
  input: SaveMaterialIssueRequest,
  nowIso: string,
): MaterialIssueDto {
  return db.transaction((): MaterialIssueDto => {
    const mo = db
      .prepare("SELECT number, status FROM manufacturing_orders WHERE id = ?")
      .get(input.moId) as { number: string; status: string } | undefined;
    if (mo === undefined) throw new MaterialIssueError("The manufacturing order was not found.");

    const idempotencyKey =
      input.idempotencyKey ?? `issue:${input.moId}:${input.componentProductId}:${nowIso}`;

    const existing = db
      .prepare("SELECT id FROM manufacturing_material_issues WHERE idempotency_key = ?")
      .get(idempotencyKey) as { id: number } | undefined;
    if (existing !== undefined) {
      const row = db
        .prepare(
          `SELECT mi.*, mo.number AS mo_number, p.sku AS component_sku, p.name AS component_name
             FROM manufacturing_material_issues mi
             JOIN manufacturing_orders mo ON mo.id = mi.mo_id
             JOIN products p ON p.id = mi.component_product_id
            WHERE mi.id = ?`,
        )
        .get(existing.id) as MaterialIssueRow | undefined;
      if (row !== undefined) return mapMaterialIssue(row);
    }

    const ctx = stockContext(db, actor.name, nowIso);
    const fromLocation = input.fromLocationId ?? defaultLocationId(db);
    const wipLocation = defaultLocationId(db); // WIP location (could be a dedicated WIP location)

    // Check available (sellable, unreserved) stock at source location.
    const available = availableQuantity(db, input.componentProductId, fromLocation);
    if (available < input.quantityMilli) {
      throw new MaterialIssueError(
        `Not enough stock at source location. Available: ${String(
          Math.round(available / 1000),
        )}, requested: ${String(Math.round(input.quantityMilli / 1000))}.`,
      );
    }

    // Issue from source to WIP: this is a location transfer (affectProductTotal: false).
    // Outbound from source (available status).
    postMovement(ctx, {
      productId: input.componentProductId,
      locationId: fromLocation,
      movementDate: nowIso.slice(0, 10),
      kind: "issue",
      quantityMilli: -input.quantityMilli,
      stockStatus: "available",
      sourceKind: "manufacturingOrder",
      sourceId: input.moId,
      notes: `Material issue to WIP for ${mo.number}`,
      affectProductTotal: false,
      idempotencyKey: `${idempotencyKey}:out`,
      allowNegativeOverride: false,
    });

    // Inbound to WIP location (inTransit status - physically in WIP, not yet consumed).
    postMovement(ctx, {
      productId: input.componentProductId,
      locationId: wipLocation,
      movementDate: nowIso.slice(0, 10),
      kind: "receipt",
      quantityMilli: input.quantityMilli,
      stockStatus: "inTransit",
      sourceKind: "manufacturingOrder",
      sourceId: input.moId,
      notes: `Material in WIP for ${mo.number}`,
      affectProductTotal: false,
      idempotencyKey: `${idempotencyKey}:transit`,
      allowNegativeOverride: false,
    });

    // Release the corresponding reservation.
    releaseReservations(db, "manufacturingOrder", input.moId, "consumed", nowIso);

    const info = db
      .prepare(
        `INSERT INTO manufacturing_material_issues
           (mo_id, work_order_id, component_product_id, quantity_milli, unit,
            issue_type, from_location_id, to_location_id, idempotency_key, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, 'issue', ?, ?, ?, ?, ?)`,
      )
      .run(
        input.moId,
        input.workOrderId ?? null,
        input.componentProductId,
        input.quantityMilli,
        "pcs",
        fromLocation,
        wipLocation,
        idempotencyKey,
        nowIso,
        actor.name,
      );

    const id = Number(info.lastInsertRowid);

    recordAudit(
      db,
      actor,
      {
        module: "manufacturing",
        action: "issueMaterial",
        entityType: "materialIssue",
        entityId: id,
        newValues: { moId: input.moId, componentProductId: input.componentProductId, quantityMilli: input.quantityMilli },
      },
      nowIso,
    );

    const row = db
      .prepare(
        `SELECT mi.*, mo.number AS mo_number, p.sku AS component_sku, p.name AS component_name
           FROM manufacturing_material_issues mi
           JOIN manufacturing_orders mo ON mo.id = mi.mo_id
           JOIN products p ON p.id = mi.component_product_id
          WHERE mi.id = ?`,
      )
      .get(id) as MaterialIssueRow | undefined;
    if (row === undefined) throw new MaterialIssueError("The material issue could not be read back.");
    return mapMaterialIssue(row);
  })();
}

export function returnMaterialFromWip(
  db: SqliteDatabase,
  actor: AuditActor,
  input: SaveMaterialIssueRequest,
  nowIso: string,
): MaterialIssueDto {
  return db.transaction((): MaterialIssueDto => {
    const mo = db
      .prepare("SELECT number FROM manufacturing_orders WHERE id = ?")
      .get(input.moId) as { number: string } | undefined;
    if (mo === undefined) throw new MaterialIssueError("The manufacturing order was not found.");

    const idempotencyKey =
      input.idempotencyKey ?? `ret:${input.moId}:${input.componentProductId}:${nowIso}`;

    const existing = db
      .prepare("SELECT id FROM manufacturing_material_issues WHERE idempotency_key = ?")
      .get(idempotencyKey) as { id: number } | undefined;
    if (existing !== undefined) {
      const row = db
        .prepare(
          `SELECT mi.*, mo.number AS mo_number, p.sku AS component_sku, p.name AS component_name
             FROM manufacturing_material_issues mi
             JOIN manufacturing_orders mo ON mo.id = mi.mo_id
             JOIN products p ON p.id = mi.component_product_id
            WHERE mi.id = ?`,
        )
        .get(existing.id) as MaterialIssueRow | undefined;
      if (row !== undefined) return mapMaterialIssue(row);
    }

    const ctx = stockContext(db, actor.name, nowIso);
    const wipLocation = defaultLocationId(db);
    const toLocation = input.toLocationId ?? defaultLocationId(db);

    // Return from WIP (inTransit) back to storage (available).
    postMovement(ctx, {
      productId: input.componentProductId,
      locationId: wipLocation,
      movementDate: nowIso.slice(0, 10),
      kind: "issue",
      quantityMilli: -input.quantityMilli,
      stockStatus: "inTransit",
      sourceKind: "manufacturingOrder",
      sourceId: input.moId,
      notes: `Material returned from WIP for ${mo.number}`,
      affectProductTotal: false,
      idempotencyKey: `${idempotencyKey}:out`,
      allowNegativeOverride: false,
    });

    postMovement(ctx, {
      productId: input.componentProductId,
      locationId: toLocation,
      movementDate: nowIso.slice(0, 10),
      kind: "receipt",
      quantityMilli: input.quantityMilli,
      stockStatus: "available",
      sourceKind: "manufacturingOrder",
      sourceId: input.moId,
      notes: `Material returned to storage for ${mo.number}`,
      affectProductTotal: false,
      idempotencyKey: `${idempotencyKey}:in`,
      allowNegativeOverride: false,
    });

    const info = db
      .prepare(
        `INSERT INTO manufacturing_material_issues
           (mo_id, work_order_id, component_product_id, quantity_milli, unit,
            issue_type, from_location_id, to_location_id, idempotency_key, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, 'return', ?, ?, ?, ?, ?)`,
      )
      .run(
        input.moId,
        input.workOrderId ?? null,
        input.componentProductId,
        input.quantityMilli,
        "pcs",
        wipLocation,
        toLocation,
        idempotencyKey,
        nowIso,
        actor.name,
      );

    const id = Number(info.lastInsertRowid);

    recordAudit(
      db,
      actor,
      {
        module: "manufacturing",
        action: "returnMaterial",
        entityType: "materialIssue",
        entityId: id,
        newValues: { moId: input.moId, componentProductId: input.componentProductId, quantityMilli: input.quantityMilli },
      },
      nowIso,
    );

    const row = db
      .prepare(
        `SELECT mi.*, mo.number AS mo_number, p.sku AS component_sku, p.name AS component_name
           FROM manufacturing_material_issues mi
           JOIN manufacturing_orders mo ON mo.id = mi.mo_id
           JOIN products p ON p.id = mi.component_product_id
          WHERE mi.id = ?`,
      )
      .get(id) as MaterialIssueRow | undefined;
    if (row === undefined) throw new MaterialIssueError("The material return could not be read back.");
    return mapMaterialIssue(row);
  })();
}

export function consumeMaterial(
  db: SqliteDatabase,
  actor: AuditActor,
  input: SaveConsumptionRecordRequest,
  nowIso: string,
): ConsumptionRecordDto {
  return db.transaction((): ConsumptionRecordDto => {
    const mo = db
      .prepare("SELECT number, status FROM manufacturing_orders WHERE id = ?")
      .get(input.moId) as { number: string; status: string } | undefined;
    if (mo === undefined) throw new MaterialIssueError("The manufacturing order was not found.");

    const ctx = stockContext(db, actor.name, nowIso);
    const wipLocation = defaultLocationId(db);

    // Consume from WIP (inTransit stock) - this reduces company total.
    const available = availableQuantity(db, input.componentProductId, wipLocation);
    if (available < input.quantityMilli) {
      throw new MaterialIssueError(
        `Not enough WIP stock to consume. Available: ${String(
          Math.round(available / 1000),
        )}, requested: ${String(Math.round(input.quantityMilli / 1000))}.`,
      );
    }

    const costRow = db
      .prepare("SELECT average_cost_fils FROM products WHERE id = ?")
      .get(input.componentProductId) as { average_cost_fils: number } | undefined;
    const unitCost = input.unitCostFils ?? costRow?.average_cost_fils ?? 0;
    const costFils = Math.round((input.quantityMilli * unitCost) / 1000);

    // Post consumption as an outbound movement from WIP (affects product total).
    const movement = postMovement(ctx, {
      productId: input.componentProductId,
      locationId: wipLocation,
      movementDate: nowIso.slice(0, 10),
      kind: "issue",
      quantityMilli: -input.quantityMilli,
      stockStatus: "inTransit",
      unitCostFils: unitCost,
      sourceKind: "manufacturingOrder",
      sourceId: input.moId,
      notes: `Material consumed for ${mo.number}`,
      affectProductTotal: true,
      allowNegativeOverride: false,
    });

    const info = db
      .prepare(
        `INSERT INTO manufacturing_consumption_records
           (mo_id, work_order_id, component_product_id, quantity_milli, unit_cost_fils,
            cost_fils, stock_movement_id, batch_no, serial_no, consumed_at, consumed_by, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.moId,
        input.workOrderId ?? null,
        input.componentProductId,
        input.quantityMilli,
        unitCost,
        costFils,
        movement.id,
        input.batchNo ?? null,
        input.serialNo ?? null,
        nowIso.slice(0, 10),
        actor.name,
        input.notes ?? null,
      );

    const id = Number(info.lastInsertRowid);

    // Update issued/consumed tracking on the MO component.
    db.prepare(
      `UPDATE manufacturing_order_components
          SET consumed_quantity = consumed_quantity + ?
        WHERE mo_id = ? AND component_product_id = ?`,
    ).run(input.quantityMilli, input.moId, input.componentProductId);

    recordAudit(
      db,
      actor,
      {
        module: "manufacturing",
        action: "consumeMaterial",
        entityType: "consumptionRecord",
        entityId: id,
        newValues: { moId: input.moId, componentProductId: input.componentProductId, quantityMilli: input.quantityMilli, costFils },
      },
      nowIso,
    );

    const row = db
      .prepare(
        `SELECT cr.*, mo.number AS mo_number, p.sku AS component_sku, p.name AS component_name
           FROM manufacturing_consumption_records cr
           JOIN manufacturing_orders mo ON mo.id = cr.mo_id
           JOIN products p ON p.id = cr.component_product_id
          WHERE cr.id = ?`,
      )
      .get(id) as ConsumptionRecordRow | undefined;
    if (row === undefined) throw new MaterialIssueError("The consumption record could not be read back.");
    return mapConsumptionRecord(row);
  })();
}

export function listConsumptionRecords(
  db: SqliteDatabase,
  moId?: number,
): ConsumptionRecordDto[] {
  const clauses: string[] = ["1 = 1"];
  const params: (string | number)[] = [];
  if (moId !== undefined) {
    clauses.push("cr.mo_id = ?");
    params.push(moId);
  }

  const rows = db
    .prepare(
      `SELECT cr.*, mo.number AS mo_number, p.sku AS component_sku, p.name AS component_name
         FROM manufacturing_consumption_records cr
         JOIN manufacturing_orders mo ON mo.id = cr.mo_id
         JOIN products p ON p.id = cr.component_product_id
        WHERE ${clauses.join(" AND ")}
        ORDER BY cr.consumed_at DESC`,
    )
    .all(...params) as ConsumptionRecordRow[];

  return rows.map(mapConsumptionRecord);
}
