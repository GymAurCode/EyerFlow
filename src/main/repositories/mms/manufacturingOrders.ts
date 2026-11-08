/**
 * Manufacturing Order repository.
 *
 * A manufacturing order (MO) is the central production document. It references
 * a snapshotted approved BOM and routing revision, calculates material
 * requirements, creates reservations and work orders on release, and tracks
 * actual production against plan.
 *
 * Stock is never changed directly here: material issues/consumptions and
 * finished-goods receipts post through the existing IMS stock engine
 * (`postMovement`, `reserveStock`, `releaseReservations`) so there is one
 * authoritative ledger shared with IMS.
 */

import type { SqliteDatabase } from "../../../data/connection";
import type { ImsDocumentKind } from "../../../shared/ims";
import {
  availableQuantity,
  defaultLocationId,
  postMovement,
  releaseReservations,
  reserveStock,
  type StockContext,
} from "../ims/stock";
import type {
  ManufacturingOrderDto,
  MoComponentDto,
  MoListRequest,
  SaveManufacturingOrderRequest,
} from "../../../shared/types";
import type { AuditActor } from "../../audit-writer";
import { recordAudit } from "../../audit-writer";
import * as bom from "./bom";

export class MoError extends Error {
  public constructor(message: string, public readonly field?: string) {
    super(message);
    this.name = "MoError";
  }
}

interface MoRow {
  readonly planning_location_id?: number | null;
  readonly id: number;
  readonly number: string;
  readonly product_id: number;
  readonly variant_id: number | null;
  readonly bom_id: number;
  readonly bom_version_id: number | null;
  readonly route_id: number | null;
  readonly route_version_id: number | null;
  readonly planned_quantity: number;
  readonly actual_quantity: number;
  readonly accepted_quantity: number;
  readonly rejected_quantity: number;
  readonly unit: string;
  readonly planned_start: string | null;
  readonly planned_finish: string | null;
  readonly actual_start: string | null;
  readonly actual_finish: string | null;
  readonly plant: string | null;
  readonly source_demand: string | null;
  readonly priority: number;
  readonly status: string;
  readonly planned_cost_fils: number;
  readonly actual_cost_fils: number;
  readonly created_by: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly product_sku: string;
  readonly product_name: string;
  readonly variant_label: string | null;
  readonly bom_number: string;
  readonly route_number: string | null;
}

interface MoComponentRow {
  readonly id: number;
  readonly mo_id: number;
  readonly component_product_id: number;
  readonly required_quantity: number;
  readonly issued_quantity: number;
  readonly consumed_quantity: number;
  readonly unit: string;
  readonly source_bom_line_id: number | null;
  readonly line_no: number;
  readonly notes: string | null;
  readonly component_sku: string;
  readonly component_name: string;
}

function mapMoComponent(row: MoComponentRow): MoComponentDto {
  return {
    id: row.id,
    moId: row.mo_id,
    componentProductId: row.component_product_id,
    componentSku: row.component_sku,
    componentName: row.component_name,
    requiredQuantity: row.required_quantity,
    issuedQuantity: row.issued_quantity,
    consumedQuantity: row.consumed_quantity,
    unit: row.unit,
    sourceBomLineId: row.source_bom_line_id,
    lineNo: row.line_no,
    notes: row.notes,
  };
}

function mapMo(row: MoRow, components: readonly MoComponentDto[]): ManufacturingOrderDto {
  return {
    planningLocationId: row.planning_location_id ?? null,
    id: row.id,
    number: row.number,
    productId: row.product_id,
    productSku: row.product_sku,
    productName: row.product_name,
    variantId: row.variant_id,
    variantLabel: row.variant_label,
    bomId: row.bom_id,
    bomNumber: row.bom_number,
    bomVersionId: row.bom_version_id,
    routeId: row.route_id,
    routeNumber: row.route_number,
    plannedQuantity: row.planned_quantity,
    actualQuantity: row.actual_quantity,
    acceptedQuantity: row.accepted_quantity,
    rejectedQuantity: row.rejected_quantity,
    unit: row.unit,
    plannedStart: row.planned_start,
    plannedFinish: row.planned_finish,
    actualStart: row.actual_start,
    actualFinish: row.actual_finish,
    plant: row.plant,
    sourceDemand: row.source_demand,
    priority: row.priority,
    status: row.status as ManufacturingOrderDto["status"],
    plannedCostFils: row.planned_cost_fils,
    actualCostFils: row.actual_cost_fils,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    components,
  };
}

export function listManufacturingOrders(
  db: SqliteDatabase,
  request: MoListRequest,
): ManufacturingOrderDto[] {
  const clauses: string[] = ["1 = 1"];
  const params: (string | number)[] = [];

  if (request.productId !== undefined) {
    clauses.push("mo.product_id = ?");
    params.push(request.productId);
  }
  if (request.status !== undefined) {
    clauses.push("mo.status = ?");
    params.push(request.status);
  }
  if (request.plant !== undefined && request.plant !== "") {
    clauses.push("mo.plant = ?");
    params.push(request.plant);
  }
  if (request.fromDate !== undefined) {
    clauses.push("mo.created_at >= ?");
    params.push(request.fromDate);
  }
  if (request.toDate !== undefined) {
    clauses.push("mo.created_at <= ?");
    params.push(request.toDate);
  }
  if (request.search !== undefined && request.search.trim() !== "") {
    clauses.push("(mo.number LIKE ? OR p.sku LIKE ? OR p.name LIKE ?)");
    const like = `%${request.search.trim()}%`;
    params.push(like, like, like);
  }

  const where = ` WHERE ${clauses.join(" AND ")}`;
  const limit = request.limit ?? 500;

  const rows = db
    .prepare(
      `SELECT mo.*, p.sku AS product_sku, p.name AS product_name, p.variant_label,
              b.number AS bom_number, r.number AS route_number
         FROM manufacturing_orders mo
         JOIN products p ON p.id = mo.product_id
         JOIN manufacturing_boms b ON b.id = mo.bom_id
         LEFT JOIN manufacturing_routes r ON r.id = mo.route_id
        ${where}
        ORDER BY mo.updated_at DESC
        LIMIT ?`,
    )
    .all(...params, limit) as MoRow[];

  const result: ManufacturingOrderDto[] = [];
  for (const row of rows) {
    const components = db
      .prepare(
        `SELECT c.*, p.sku AS component_sku, p.name AS component_name
           FROM manufacturing_order_components c
           JOIN products p ON p.id = c.component_product_id
          WHERE c.mo_id = ?
          ORDER BY c.line_no, c.id`,
      )
      .all(row.id) as MoComponentRow[];

    result.push(mapMo(row, components.map(mapMoComponent)));
  }
  return result;
}

export function getManufacturingOrder(
  db: SqliteDatabase,
  id: number,
): ManufacturingOrderDto {
  const row = db
    .prepare(
      `SELECT mo.*, p.sku AS product_sku, p.name AS product_name, p.variant_label,
              b.number AS bom_number, r.number AS route_number
         FROM manufacturing_orders mo
         JOIN products p ON p.id = mo.product_id
         JOIN manufacturing_boms b ON b.id = mo.bom_id
         LEFT JOIN manufacturing_routes r ON r.id = mo.route_id
        WHERE mo.id = ?`,
    )
    .get(id) as MoRow | undefined;
  if (row === undefined) throw new MoError(`Manufacturing order ${String(id)} was not found.`);

  const components = db
    .prepare(
      `SELECT c.*, p.sku AS component_sku, p.name AS component_name
         FROM manufacturing_order_components c
         JOIN products p ON p.id = c.component_product_id
        WHERE c.mo_id = ?
        ORDER BY c.line_no, c.id`,
    )
    .all(row.id) as MoComponentRow[];

  return mapMo(row, components.map(mapMoComponent));
}

function nextMoNumber(db: SqliteDatabase): string {
  const row = db
    .prepare(
      "SELECT number FROM manufacturing_orders WHERE number LIKE 'MO-%' ORDER BY LENGTH(number) DESC, number DESC LIMIT 1",
    )
    .get() as { number?: string } | undefined;
  const last = row?.number === undefined ? 0 : Number.parseInt(row.number.slice(3), 10);
  return `MO-${String((Number.isFinite(last) ? last : 0) + 1).padStart(5, "0")}`;
}

function calculateMaterialRequirements(
  db: SqliteDatabase,
  bomId: number,
  plannedQuantity: number,
): {
  readonly components: {
    readonly componentProductId: number;
    readonly quantityPerUnit: number;
    readonly unit: string;
    readonly scrapPercent: number;
    readonly lineNo: number;
  }[];
  readonly totalCostFils: number;
} {
  const components = db
    .prepare(
      `SELECT component_product_id, quantity_per_unit, unit, scrap_percent, line_no
         FROM manufacturing_bom_components
        WHERE bom_id = ?
        ORDER BY line_no, id`,
    )
    .all(bomId) as {
    component_product_id: number;
    quantity_per_unit: number;
    unit: string;
    scrap_percent: number;
    line_no: number;
  }[];

  const exploded: {
    readonly componentProductId: number;
    readonly quantityPerUnit: number;
    readonly unit: string;
    readonly scrapPercent: number;
    readonly lineNo: number;
  }[] = [];
  let totalCostFils = 0;

  for (const comp of components) {
    // Scale per-unit quantity to the MO quantity, then add scrap allowance.
    const baseQty = Math.round((comp.quantity_per_unit * plannedQuantity) / 1000);
    const scrapQty = Math.round((baseQty * comp.scrap_percent) / 100);
    const totalQty = baseQty + scrapQty;

    const costRow = db
      .prepare("SELECT average_cost_fils FROM products WHERE id = ?")
      .get(comp.component_product_id) as { average_cost_fils: number } | undefined;
    const unitCost = costRow?.average_cost_fils ?? 0;
    totalCostFils += Math.round((totalQty * unitCost) / 1000);

    exploded.push({
      componentProductId: comp.component_product_id,
      quantityPerUnit: totalQty,
      unit: comp.unit,
      scrapPercent: comp.scrap_percent,
      lineNo: comp.line_no,
    });
  }

  return { components: exploded, totalCostFils };
}

export function saveManufacturingOrder(
  db: SqliteDatabase,
  actor: AuditActor,
  input: SaveManufacturingOrderRequest,
  nowIso: string,
): ManufacturingOrderDto {
  return db.transaction((): ManufacturingOrderDto => {
    if (input.id !== undefined) {
      const before = db
        .prepare("SELECT * FROM manufacturing_orders WHERE id = ?")
        .get(input.id) as Record<string, unknown> | undefined;
      if (before === undefined)
        throw new MoError(`Manufacturing order ${String(input.id)} was not found.`);

      // A released or later MO cannot be edited except for notes/plant.
      if (
        ["released", "inProgress", "qualityReview", "completed", "closed"].includes(
          before.status as string,
        ) &&
        (input.productId !== undefined ||
          input.bomId !== undefined ||
          input.plannedQuantity !== undefined)
      ) {
        throw new MoError(
          "A released or later manufacturing order cannot be edited. Create a new one instead.",
        );
      }

      db.prepare(
        `UPDATE manufacturing_orders
            SET number = COALESCE(?, number),
                product_id = COALESCE(?, product_id),
                variant_id = COALESCE(?, variant_id),
                bom_id = COALESCE(?, bom_id),
                route_id = COALESCE(?, route_id),
                planned_quantity = COALESCE(?, planned_quantity),
                unit = COALESCE(?, unit),
                planned_start = COALESCE(?, planned_start),
                planned_finish = COALESCE(?, planned_finish),
                plant = COALESCE(?, plant),
                source_demand = COALESCE(?, source_demand),
                priority = COALESCE(?, priority),
                status = COALESCE(?, status),
                updated_at = ?
          WHERE id = ?`,
      ).run(
        input.number ?? null,
        input.productId ?? null,
        input.variantId ?? null,
        input.bomId ?? null,
        input.routeId ?? null,
        input.plannedQuantity ?? null,
        input.unit ?? null,
        input.plannedStart ?? null,
        input.plannedFinish ?? null,
        input.plant ?? null,
        input.sourceDemand ?? null,
        input.priority ?? null,
        input.status ?? null,
        nowIso,
        input.id,
      );

      recordAudit(
        db,
        actor,
        {
          module: "manufacturing",
          action: "update",
          entityType: "manufacturingOrder",
          entityId: input.id,
          oldValues: before,
          newValues: input,
        },
        nowIso,
      );

      return getManufacturingOrder(db, input.id);
    }

    const productId = input.productId;
    const bomId = input.bomId;
    const routeId = input.routeId ?? null;
    const number = input.number !== undefined && input.number.length > 0 ? input.number : nextMoNumber(db);

    // Validate BOM exists and is approved.
    const bomRow = db
      .prepare("SELECT status FROM manufacturing_boms WHERE id = ?")
      .get(bomId) as { status: string } | undefined;
    if (bomRow === undefined) throw new MoError(`BOM ${String(bomId)} was not found.`);
    if (bomRow.status !== "approved") {
      throw new MoError("A manufacturing order requires an approved BOM revision.");
    }

    // Calculate material requirements from the snapshotted BOM.
    const { components, totalCostFils } = calculateMaterialRequirements(
      db,
      bomId,
      input.plannedQuantity,
    );

    const info = db
      .prepare(
        `INSERT INTO manufacturing_orders
           (number, product_id, variant_id, bom_id, bom_version_id, route_id,
            planned_quantity, unit, planned_start, planned_finish, plant,
            source_demand, priority, status, planned_cost_fils, actual_cost_fils,
            created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 0, 'planned', ?, 0, ?, ?, ?)`,
      )
      .run(
        number,
        productId,
        input.variantId ?? null,
        bomId,
        routeId,
        input.plannedQuantity,
        input.unit ?? "pcs",
        input.plannedStart ?? null,
        input.plannedFinish ?? null,
        input.plant ?? null,
        input.sourceDemand ?? null,
        totalCostFils,
        actor.name,
        nowIso,
        nowIso,
      );

    const id = Number(info.lastInsertRowid);

    // Persist immutable material requirement snapshot.
    let lineNo = 1;
    for (const comp of components) {
      db.prepare(
        `INSERT INTO manufacturing_order_components
           (mo_id, component_product_id, required_quantity, unit, source_bom_line_id, line_no, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        comp.componentProductId,
        comp.quantityPerUnit,
        comp.unit,
        comp.lineNo,
        lineNo,
        null,
      );
      lineNo += 1;
    }

    recordAudit(
      db,
      actor,
      {
        module: "manufacturing",
        action: "create",
        entityType: "manufacturingOrder",
        entityId: id,
        newValues: { number, productId, bomId, plannedQuantity: input.plannedQuantity },
      },
      nowIso,
    );

    return getManufacturingOrder(db, id);
  })();
}

/**
 * Release a manufacturing order to production.
 *
 * Preconditions:
 *  1. BOM is approved (verified at creation).
 *  2. Routing revision exists (if referenced).
 *  3. Material requirements calculated (snapshot at creation).
 *  4. Available components checked against IMS stock.
 *  5. Scheduling feasibility (work centers operational).
 *  6. Permissions (checked by RPC layer).
 *
 * On release:
 *  - Creates work orders from the routing.
 *  - Creates material reservations (stock reserved, not consumed).
 *  - Status: planned → confirmed → released.
 */

export function releaseManufacturingOrder(
  db: SqliteDatabase,
  actor: AuditActor,
  id: number,
  nowIso: string,
): ManufacturingOrderDto {
  return db.transaction((): ManufacturingOrderDto => {
    const mo = getManufacturingOrder(db, id);
    if (mo.status !== "planned" && mo.status !== "confirmed") {
      throw new MoError(
        `This manufacturing order cannot be released from status "${mo.status}".`,
      );
    }

    // 1. Verify routing exists (if referenced).
    if (mo.routeId !== null) {
      const route = db
        .prepare("SELECT id FROM manufacturing_routes WHERE id = ?")
        .get(mo.routeId) as { id: number } | undefined;
      if (route === undefined) throw new MoError("The referenced routing was not found.");
    }

    // 2. Check available components against IMS stock (sellable/available).
    const shortages: string[] = [];
    const components = db
      .prepare(
        `SELECT c.*, p.name AS product_name
           FROM manufacturing_order_components c
           JOIN products p ON p.id = c.component_product_id
          WHERE c.mo_id = ?
          ORDER BY c.line_no`,
      )
      .all(id) as {
      id: number;
      component_product_id: number;
      required_quantity: number;
      issued_quantity: number;
      product_name: string;
    }[];

    for (const comp of components) {
      const available = availableQuantity(db, comp.component_product_id);
      if (available < comp.required_quantity) {
        shortages.push(
          `${comp.product_name}: required ${String(
            comp.required_quantity / 1000,
          )}, available ${String(available / 1000)}`,
        );
      }
    }
    if (shortages.length > 0) {
      throw new MoError(
        `Insufficient components to release: ${shortages.join("; ")}. Receive materials or adjust the order quantity first.`,
      );
    }

    // 3. Create work orders from the routing.
    if (mo.routeId !== null) {
      const operations = db
        .prepare(
          `SELECT * FROM manufacturing_route_operations
             WHERE route_id = ?
             ORDER BY sequence, id`,
        )
        .all(mo.routeId) as {
        id: number;
        name: string;
        expected_output_qty: number;
        cycle_time_minutes: number;
        work_center_id: number | null;
      }[];

      if (operations.length === 0) {
        throw new MoError("The routing has no operations. Add operations before releasing.");
      }

      for (const op of operations) {
        const existingWo = db
          .prepare(
            "SELECT id FROM manufacturing_work_orders WHERE mo_id = ? AND route_operation_id = ?",
          )
          .get(id, op.id) as { id: number } | undefined;
        if (existingWo === undefined) {
          // First operation is ready if no prerequisite; others blocked.
          const prereq = db
            .prepare(
              "SELECT prerequisite_op_id FROM manufacturing_route_operations WHERE id = ?",
            )
            .get(op.id) as { prerequisite_op_id: number | null } | undefined;
          const hasPrerequisite = prereq?.prerequisite_op_id !== null;
          const status = hasPrerequisite ? "blocked" : "ready";

          db.prepare(
            `INSERT INTO manufacturing_work_orders
               (mo_id, route_operation_id, planned_quantity, status, notes)
             VALUES (?, ?, ?, ?, ?)`,
          ).run(id, op.id, mo.plannedQuantity, status, null);
        }
      }
    }

    // 4. Create material reservations through IMS stock engine.
    const stockContext: StockContext = {
      db,
      actorName: actor.name,
      nowIso,
      nowDate: nowIso.slice(0, 10),
      allowNegativeStock: false,
    };

    for (const comp of components) {
      const alreadyReserved = db
        .prepare(
          `SELECT COALESCE(SUM(quantity_milli), 0) AS total FROM manufacturing_material_issues
            WHERE mo_id = ? AND component_product_id = ? AND issue_type = 'reservation'`,
        )
        .get(id, comp.component_product_id) as { total: number };

      const remaining = comp.required_quantity - (alreadyReserved.total ?? 0);
      if (remaining > 0) {
        reserveStock(
          db,
          actor.name,
          {
            productId: comp.component_product_id,
            quantityMilli: remaining,
            sourceKind: "manufacturingOrder" as ImsDocumentKind,
            sourceId: id,
            notes: `Reserved for ${mo.number}`,
          },
          nowIso,
        );        // The reservation row has no notes column in the MMS schema, and the
        // release path must match the table exactly: an INSERT naming a column
        // that does not exist fails the whole release.
        db.prepare(
          `INSERT INTO manufacturing_material_issues
             (mo_id, component_product_id, quantity_milli, unit, issue_type, created_at, created_by)
           VALUES (?, ?, ?, ?, 'reservation', ?, ?)`,
        ).run(id, comp.component_product_id, remaining, "pcs", nowIso, actor.name);
      }
    }

    // 5. Advance status.
    const newStatus = mo.status === "planned" ? "confirmed" : mo.status;
    db.prepare(
      "UPDATE manufacturing_orders SET status = 'released', updated_at = ? WHERE id = ?",
    ).run(nowIso, id);

    recordAudit(
      db,
      actor,
      {
        module: "manufacturing",
        action: "release",
        entityType: "manufacturingOrder",
        entityId: id,
        newValues: { status: "released", reservations: components.length },
      },
      nowIso,
    );

    return getManufacturingOrder(db, id);
  })();
}

export function cancelManufacturingOrder(
  db: SqliteDatabase,
  actor: AuditActor,
  id: number,
  reason: string,
  nowIso: string,
): ManufacturingOrderDto {
  return db.transaction((): ManufacturingOrderDto => {
    const mo = getManufacturingOrder(db, id);
    if (mo.status === "completed" || mo.status === "closed") {
      throw new MoError("A completed or closed manufacturing order cannot be cancelled.");
    }
    if (mo.status === "cancelled") {
      throw new MoError("This manufacturing order is already cancelled.");
    }

    // Release active reservations back to available stock.
    releaseReservations(db, "manufacturingOrder", id, "released", nowIso);

    // The order table has no reason column; the cancellation reason is kept in
    // the audit trail, which is where a cancellation is read back from.
    db.prepare(
      "UPDATE manufacturing_orders SET status = 'cancelled', updated_at = ? WHERE id = ?",
    ).run(nowIso, id);

    recordAudit(
      db,
      actor,
      { module: "manufacturing", action: "cancel", entityType: "manufacturingOrder", entityId: id, newValues: { reason } },
      nowIso,
    );

    return getManufacturingOrder(db, id);
  })();
}
