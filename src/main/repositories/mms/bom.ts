/**
 * Bill of Materials repository.
 *
 * A BOM is the material structure of a manufactured product. Only approved
 * BOM revisions may be released to production, and a released manufacturing
 * order stores an immutable snapshot of its BOM revision. Changes to a
 * current BOM never rewrite old manufacturing orders.
 *
 * Circular component relationships are detected and rejected. A product
 * cannot list itself as a component, directly or transitively.
 */

import type { SqliteDatabase } from "../../../data/connection";
import type {
  BomComponentDto,
  BomDto,
  BomListRequest,
  SaveBomComponentRequest,
  SaveBomRequest,
} from "../../../shared/types";
import type { AuditActor } from "../../audit-writer";
import { recordAudit } from "../../audit-writer";

export class BomError extends Error {
  public constructor(message: string, public readonly field?: string) {
    super(message);
    this.name = "BomError";
  }
}

interface BomRow {
  readonly id: number;
  readonly number: string;
  readonly product_id: number;
  readonly variant_id: number | null;
  readonly name: string;
  readonly description: string | null;
  readonly bom_type: string;
  readonly base_output_quantity: number;
  readonly output_unit: string;
  readonly expected_scrap_percent: number;
  readonly routing_id: number | null;
  readonly expected_production_time_minutes: number | null;
  readonly effective_from: string;
  readonly effective_to: string | null;
  readonly status: string;
  readonly created_by: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly product_sku: string;
  readonly product_name: string;
  readonly variant_label: string | null;
  readonly routing_name: string | null;
}

interface BomComponentRow {
  readonly id: number;
  readonly bom_id: number;
  readonly component_product_id: number;
  readonly quantity_per_unit: number;
  readonly unit: string;
  readonly scrap_percent: number;
  readonly is_optional: number;
  readonly substitution_allowed: number;
  readonly line_no: number;
  readonly notes: string | null;
  readonly component_sku: string;
  readonly component_name: string;
}

function mapBomComponent(row: BomComponentRow): BomComponentDto {
  return {
    id: row.id,
    bomId: row.bom_id,
    componentProductId: row.component_product_id,
    componentSku: row.component_sku,
    componentName: row.component_name,
    quantityPerUnit: row.quantity_per_unit,
    unit: row.unit,
    scrapPercent: row.scrap_percent,
    isOptional: row.is_optional === 1,
    substitutionAllowed: row.substitution_allowed === 1,
    lineNo: row.line_no,
    notes: row.notes,
  };
}

function mapBom(row: BomRow, components: readonly BomComponentDto[]): BomDto {
  return {
    id: row.id,
    number: row.number,
    productId: row.product_id,
    productSku: row.product_sku,
    productName: row.product_name,
    variantId: row.variant_id,
    variantLabel: row.variant_label,
    name: row.name,
    description: row.description,
    bomType: row.bom_type as BomDto["bomType"],
    baseOutputQuantity: row.base_output_quantity,
    outputUnit: row.output_unit,
    expectedScrapPercent: row.expected_scrap_percent,
    routingId: row.routing_id,
    routingName: row.routing_name,
    expectedProductionTimeMinutes: row.expected_production_time_minutes,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    status: row.status as BomDto["status"],
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    components,
  };
}

/**
 * Detect circular component relationships. A BOM cannot contain itself,
 * directly or transitively. Returns the chain when a cycle is found.
 */
function findCycle(
  db: SqliteDatabase,
  startProductId: number,
  currentProductId: number,
  visited: Set<number>,
  path: number[],
): number[] | null {
  if (currentProductId === startProductId && path.length > 0) return path;
  if (visited.has(currentProductId)) return null;
  visited.add(currentProductId);

  const components = db
    .prepare(
      "SELECT component_product_id FROM manufacturing_bom_components WHERE bom_id IN (SELECT id FROM manufacturing_boms WHERE product_id = ? AND status = 'approved')",
    )
    .all(currentProductId) as { component_product_id: number }[];

  for (const comp of components) {
    const result = findCycle(
      db,
      startProductId,
      comp.component_product_id,
      visited,
      [...path, comp.component_product_id],
    );
    if (result !== null) return result;
  }
  return null;
}

function assertNoCycle(
  db: SqliteDatabase,
  productId: number,
  componentProductId: number,
): void {
  if (componentProductId === productId) {
    throw new BomError(
      "A product cannot be a component of its own BOM.",
      "componentProductId",
    );
  }
  const cycle = findCycle(db, productId, componentProductId, new Set(), []);
  if (cycle !== null) {
    throw new BomError(
      `Adding this component would create a circular BOM: ${cycle.join(" → ")}.`,
      "componentProductId",
    );
  }
}

export function listBoms(db: SqliteDatabase, request: BomListRequest): BomDto[] {
  const clauses: string[] = ["1 = 1"];
  const params: (string | number)[] = [];

  if (request.productId !== undefined) {
    clauses.push("b.product_id = ?");
    params.push(request.productId);
  }
  if (request.status !== undefined) {
    clauses.push("b.status = ?");
    params.push(request.status);
  }
  if (request.bomType !== undefined) {
    clauses.push("b.bom_type = ?");
    params.push(request.bomType);
  }
  if (request.search !== undefined && request.search.trim() !== "") {
    clauses.push("(b.number LIKE ? OR b.name LIKE ? OR p.sku LIKE ? OR p.name LIKE ?)");
    const like = `%${request.search.trim()}%`;
    params.push(like, like, like, like);
  }

  const where = ` WHERE ${clauses.join(" AND ")}`;
  const limit = request.limit ?? 500;

  const rows = db
    .prepare(
      `SELECT b.*, p.sku AS product_sku, p.name AS product_name, p.variant_label,
              r.name AS routing_name
         FROM manufacturing_boms b
         JOIN products p ON p.id = b.product_id
         LEFT JOIN manufacturing_routes r ON r.id = b.routing_id
        ${where}
        ORDER BY b.updated_at DESC
        LIMIT ?`,
    )
    .all(...params, limit) as BomRow[];

  const result: BomDto[] = [];
  for (const row of rows) {
    const components = db
      .prepare(
        `SELECT c.*, p.sku AS component_sku, p.name AS component_name
           FROM manufacturing_bom_components c
           JOIN products p ON p.id = c.component_product_id
          WHERE c.bom_id = ?
          ORDER BY c.line_no, c.id`,
      )
      .all(row.id) as BomComponentRow[];

    result.push(mapBom(row, components.map(mapBomComponent)));
  }
  return result;
}

export function getBom(db: SqliteDatabase, id: number): BomDto {
  const row = db
    .prepare(
      `SELECT b.*, p.sku AS product_sku, p.name AS product_name, p.variant_label,
              r.name AS routing_name
         FROM manufacturing_boms b
         JOIN products p ON p.id = b.product_id
         LEFT JOIN manufacturing_routes r ON r.id = b.routing_id
        WHERE b.id = ?`,
    )
    .get(id) as BomRow | undefined;
  if (row === undefined) throw new BomError(`BOM ${String(id)} was not found.`);

  const components = db
    .prepare(
      `SELECT c.*, p.sku AS component_sku, p.name AS component_name
         FROM manufacturing_bom_components c
         JOIN products p ON p.id = c.component_product_id
        WHERE c.bom_id = ?
        ORDER BY c.line_no, c.id`,
    )
    .all(row.id) as BomComponentRow[];

  return mapBom(row, components.map(mapBomComponent));
}

export function saveBom(
  db: SqliteDatabase,
  actor: AuditActor,
  input: SaveBomRequest,
  nowIso: string,
): BomDto {
  return db.transaction((): BomDto => {
    if (input.id !== undefined) {
      const before = db
        .prepare("SELECT * FROM manufacturing_boms WHERE id = ?")
        .get(input.id) as Record<string, unknown> | undefined;
      if (before === undefined) throw new BomError(`BOM ${String(input.id)} was not found.`);

      const productId =
        input.productId !== undefined ? input.productId : (before.product_id as number);

      db.prepare(
        `UPDATE manufacturing_boms
            SET number = COALESCE(?, number),
                product_id = COALESCE(?, product_id),
                variant_id = COALESCE(?, variant_id),
                name = COALESCE(?, name),
                description = COALESCE(?, description),
                bom_type = COALESCE(?, bom_type),
                base_output_quantity = COALESCE(?, base_output_quantity),
                output_unit = COALESCE(?, output_unit),
                expected_scrap_percent = COALESCE(?, expected_scrap_percent),
                routing_id = COALESCE(?, routing_id),
                expected_production_time_minutes = COALESCE(?, expected_production_time_minutes),
                effective_from = COALESCE(?, effective_from),
                effective_to = COALESCE(?, effective_to),
                status = COALESCE(?, status),
                updated_at = ?
          WHERE id = ?`,
      ).run(
        input.number ?? null,
        input.productId ?? null,
        input.variantId ?? null,
        input.name ?? null,
        input.description ?? null,
        input.bomType ?? null,
        input.baseOutputQuantity ?? null,
        input.outputUnit ?? null,
        input.expectedScrapPercent ?? null,
        input.routingId ?? null,
        input.expectedProductionTimeMinutes ?? null,
        input.effectiveFrom ?? null,
        input.effectiveTo ?? null,
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
          entityType: "bom",
          entityId: input.id,
          oldValues: before,
          newValues: input,
        },
        nowIso,
      );

      return getBom(db, input.id);
    }

    const productId = input.productId;
    const number =
      input.number !== undefined && input.number.length > 0
        ? input.number
        : nextBomNumber(db);

    const clash = db
      .prepare(
        "SELECT id FROM manufacturing_boms WHERE number = ? AND product_id = ?",
      )
      .get(number, productId) as { id?: number } | undefined;
    if (clash !== undefined) {
      throw new BomError(`BOM number ${number} is already used for this product.`);
    }

    const info = db
      .prepare(
        `INSERT INTO manufacturing_boms
           (number, product_id, variant_id, name, description, bom_type,
            base_output_quantity, output_unit, expected_scrap_percent, routing_id,
            expected_production_time_minutes, effective_from, effective_to,
            status, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
      )
      .run(
        number,
        productId,
        input.variantId ?? null,
        input.name,
        input.description ?? null,
        input.bomType ?? "assembly",
        input.baseOutputQuantity ?? 1000,
        input.outputUnit ?? "pcs",
        input.expectedScrapPercent ?? 0,
        input.routingId ?? null,
        input.expectedProductionTimeMinutes ?? null,
        input.effectiveFrom ?? nowIso.slice(0, 10),
        input.effectiveTo ?? null,
        actor.name,
        nowIso,
        nowIso,
      );

    const id = Number(info.lastInsertRowid);

    recordAudit(
      db,
      actor,
      { module: "manufacturing", action: "create", entityType: "bom", entityId: id, newValues: input },
      nowIso,
    );

    return getBom(db, id);
  })();
}

export function saveBomComponent(
  db: SqliteDatabase,
  actor: AuditActor,
  input: SaveBomComponentRequest,
  nowIso: string,
): BomComponentDto {
  return db.transaction((): BomComponentDto => {
    const bom = db
      .prepare("SELECT product_id FROM manufacturing_boms WHERE id = ?")
      .get(input.bomId) as { product_id: number } | undefined;
    if (bom === undefined) throw new BomError(`BOM ${String(input.bomId)} was not found.`);

    // Prevent cycles: a component cannot be an ancestor of the BOM product.
    assertNoCycle(db, bom.product_id, input.componentProductId);

    let id = input.id;
    if (id === undefined) {
      const maxLine = db
        .prepare("SELECT COALESCE(MAX(line_no), 0) AS max_line FROM manufacturing_bom_components WHERE bom_id = ?")
        .get(input.bomId) as { max_line: number };
      const info = db
        .prepare(
          `INSERT INTO manufacturing_bom_components
             (bom_id, component_product_id, quantity_per_unit, unit, scrap_percent,
              is_optional, substitution_allowed, line_no, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.bomId,
          input.componentProductId,
          input.quantityPerUnit,
          input.unit ?? "pcs",
          input.scrapPercent ?? 0,
          input.isOptional === true ? 1 : 0,
          input.substitutionAllowed === true ? 1 : 0,
          maxLine.max_line + 1,
          input.notes ?? null,
        );
      id = Number(info.lastInsertRowid);
    } else {
      db.prepare(
        `UPDATE manufacturing_bom_components
            SET component_product_id = COALESCE(?, component_product_id),
                quantity_per_unit = COALESCE(?, quantity_per_unit),
                unit = COALESCE(?, unit),
                scrap_percent = COALESCE(?, scrap_percent),
                is_optional = COALESCE(?, is_optional),
                substitution_allowed = COALESCE(?, substitution_allowed),
                line_no = COALESCE(?, line_no),
                notes = COALESCE(?, notes)
          WHERE id = ? AND bom_id = ?`,
      ).run(
        input.componentProductId ?? null,
        input.quantityPerUnit ?? null,
        input.unit ?? null,
        input.scrapPercent ?? null,
        input.isOptional === undefined ? null : input.isOptional ? 1 : 0,
        input.substitutionAllowed === undefined ? null : input.substitutionAllowed ? 1 : 0,
        input.lineNo ?? null,
        input.notes ?? null,
        id,
        input.bomId,
      );
    }

    recordAudit(
      db,
      actor,
      {
        module: "manufacturing",
        action: input.id === undefined ? "create" : "update",
        entityType: "bomComponent",
        entityId: id,
        newValues: input,
      },
      nowIso,
    );

    const row = db
      .prepare(
        `SELECT c.*, p.sku AS component_sku, p.name AS component_name
           FROM manufacturing_bom_components c
           JOIN products p ON p.id = c.component_product_id
          WHERE c.id = ?`,
      )
      .get(id) as BomComponentRow | undefined;
    if (row === undefined) throw new BomError("The BOM component could not be read back.");
    return mapBomComponent(row);
  })();
}

export function deleteBomComponent(
  db: SqliteDatabase,
  actor: AuditActor,
  id: number,
  nowIso: string,
): { readonly ok: true } {
  db.transaction(() => {
    const row = db
      .prepare("SELECT bom_id FROM manufacturing_bom_components WHERE id = ?")
      .get(id) as { bom_id: number } | undefined;
    if (row === undefined) throw new BomError("That BOM component was not found.");
    db.prepare("DELETE FROM manufacturing_bom_components WHERE id = ?").run(id);
    recordAudit(
      db,
      actor,
      { module: "manufacturing", action: "delete", entityType: "bomComponent", entityId: id },
      nowIso,
    );
  })();
  return { ok: true };
}

export function approveBom(
  db: SqliteDatabase,
  actor: AuditActor,
  id: number,
  nowIso: string,
): BomDto {
  return db.transaction((): BomDto => {
    const bom = getBom(db, id);
    if (bom.status === "approved") return bom;
    if (!["draft", "review"].includes(bom.status)) {
      throw new BomError("Only a draft or review BOM can be approved.");
    }
    if (bom.components.length === 0) {
      throw new BomError("A BOM must have at least one component before approval.");
    }

    db.prepare(
      "UPDATE manufacturing_boms SET status = 'approved', updated_at = ? WHERE id = ?",
    ).run(nowIso, id);

    recordAudit(
      db,
      actor,
      { module: "manufacturing", action: "approve", entityType: "bom", entityId: id },
      nowIso,
    );

    return getBom(db, id);
  })();
}

function nextBomNumber(db: SqliteDatabase): string {
  const row = db
    .prepare(
      "SELECT number FROM manufacturing_boms WHERE number LIKE 'BOM-%' ORDER BY LENGTH(number) DESC, number DESC LIMIT 1",
    )
    .get() as { number?: string } | undefined;
  const last = row?.number === undefined ? 0 : Number.parseInt(row.number.slice(4), 10);
  return `BOM-${String((Number.isFinite(last) ? last : 0) + 1).padStart(5, "0")}`;
}
