/**
 * Routing & operations repository.
 *
 * A routing defines the sequence of operations required to manufacture a
 * product. Each operation references a work center, has setup/cycle times,
 * optional prerequisites, and an optional quality checkpoint. A later
 * operation must not begin before mandatory prerequisites are satisfied
 * unless an explicitly approved override exists.
 */

import type { SqliteDatabase } from "../../../data/connection";
import type {
  RouteDto,
  RouteListRequest,
  RouteOperationDto,
  SaveRouteOperationRequest,
  SaveRouteRequest,
} from "../../../shared/types";
import type { AuditActor } from "../../audit-writer";
import { recordAudit } from "../../audit-writer";

export class RoutingError extends Error {
  public constructor(message: string, public readonly field?: string) {
    super(message);
    this.name = "RoutingError";
  }
}

interface RouteRow {
  readonly id: number;
  readonly number: string;
  readonly name: string;
  readonly description: string | null;
  readonly status: string;
  readonly effective_from: string;
  readonly effective_to: string | null;
  readonly created_by: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface RouteOperationRow {
  readonly id: number;
  readonly route_id: number;
  readonly operation_code: string;
  readonly name: string;
  readonly description: string | null;
  readonly sequence: number;
  readonly prerequisite_op_id: number | null;
  readonly work_center_id: number | null;
  readonly setup_time_minutes: number;
  readonly cycle_time_minutes: number;
  readonly expected_output_qty: number;
  readonly labor_required: number;
  readonly cost_rate_fils_per_hour: number;
  readonly quality_checkpoint: number;
  readonly work_instructions: string | null;
  readonly prerequisite_name: string | null;
  readonly work_center_name: string | null;
}

function mapRouteOperation(row: RouteOperationRow): RouteOperationDto {
  return {
    id: row.id,
    routeId: row.route_id,
    operationCode: row.operation_code,
    name: row.name,
    description: row.description,
    sequence: row.sequence,
    prerequisiteOpId: row.prerequisite_op_id,
    prerequisiteName: row.prerequisite_name,
    workCenterId: row.work_center_id,
    workCenterName: row.work_center_name,
    setupTimeMinutes: row.setup_time_minutes,
    cycleTimeMinutes: row.cycle_time_minutes,
    expectedOutputQty: row.expected_output_qty,
    laborRequired: row.labor_required,
    costRateFilsPerHour: row.cost_rate_fils_per_hour,
    qualityCheckpoint: row.quality_checkpoint === 1,
    workInstructions: row.work_instructions,
  };
}

function mapRoute(row: RouteRow, operations: readonly RouteOperationDto[]): RouteDto {
  return {
    id: row.id,
    number: row.number,
    name: row.name,
    description: row.description,
    status: row.status as RouteDto["status"],
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    operations,
  };
}

export function listRoutes(db: SqliteDatabase, request: RouteListRequest): RouteDto[] {
  const clauses: string[] = ["1 = 1"];
  const params: (string | number)[] = [];

  if (request.status !== undefined) {
    clauses.push("r.status = ?");
    params.push(request.status);
  }
  if (request.search !== undefined && request.search.trim() !== "") {
    clauses.push("(r.number LIKE ? OR r.name LIKE ?)");
    const like = `%${request.search.trim()}%`;
    params.push(like, like);
  }

  const where = ` WHERE ${clauses.join(" AND ")}`;
  const limit = request.limit ?? 500;

  const rows = db
    .prepare(
      `SELECT * FROM manufacturing_routes r${where}
        ORDER BY r.updated_at DESC LIMIT ?`,
    )
    .all(...params, limit) as RouteRow[];

  const result: RouteDto[] = [];
  for (const row of rows) {
    const operations = db
      .prepare(
        `SELECT o.*, p.name AS prerequisite_name, w.name AS work_center_name
           FROM manufacturing_route_operations o
           LEFT JOIN manufacturing_route_operations p ON p.id = o.prerequisite_op_id
           LEFT JOIN manufacturing_work_centers w ON w.id = o.work_center_id
          WHERE o.route_id = ?
          ORDER BY o.sequence, o.id`,
      )
      .all(row.id) as RouteOperationRow[];

    result.push(mapRoute(row, operations.map(mapRouteOperation)));
  }
  return result;
}

export function getRoute(db: SqliteDatabase, id: number): RouteDto {
  const row = db
    .prepare("SELECT * FROM manufacturing_routes WHERE id = ?")
    .get(id) as RouteRow | undefined;
  if (row === undefined) throw new RoutingError(`Route ${String(id)} was not found.`);

  const operations = db
    .prepare(
      `SELECT o.*, p.name AS prerequisite_name, w.name AS work_center_name
         FROM manufacturing_route_operations o
         LEFT JOIN manufacturing_route_operations p ON p.id = o.prerequisite_op_id
         LEFT JOIN manufacturing_work_centers w ON w.id = o.work_center_id
        WHERE o.route_id = ?
        ORDER BY o.sequence, o.id`,
    )
    .all(row.id) as RouteOperationRow[];

  return mapRoute(row, operations.map(mapRouteOperation));
}

export function saveRoute(
  db: SqliteDatabase,
  actor: AuditActor,
  input: SaveRouteRequest,
  nowIso: string,
): RouteDto {
  return db.transaction((): RouteDto => {
    if (input.id !== undefined) {
      const before = db
        .prepare("SELECT * FROM manufacturing_routes WHERE id = ?")
        .get(input.id) as Record<string, unknown> | undefined;
      if (before === undefined) throw new RoutingError(`Route ${String(input.id)} was not found.`);

      db.prepare(
        `UPDATE manufacturing_routes
            SET number = COALESCE(?, number),
                name = COALESCE(?, name),
                description = COALESCE(?, description),
                status = COALESCE(?, status),
                effective_from = COALESCE(?, effective_from),
                effective_to = COALESCE(?, effective_to),
                updated_at = ?
          WHERE id = ?`,
      ).run(
        input.number ?? null,
        input.name ?? null,
        input.description ?? null,
        input.status ?? null,
        input.effectiveFrom ?? null,
        input.effectiveTo ?? null,
        nowIso,
        input.id,
      );

      recordAudit(
        db,
        actor,
        { module: "manufacturing", action: "update", entityType: "route", entityId: input.id, oldValues: before, newValues: input },
        nowIso,
      );

      return getRoute(db, input.id);
    }

    const number =
      input.number !== undefined && input.number.length > 0
        ? input.number
        : nextRouteNumber(db);

    const info = db
      .prepare(
        `INSERT INTO manufacturing_routes
           (number, name, description, status, effective_from, effective_to, created_by, created_at, updated_at)
         VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?)`,
      )
      .run(
        number,
        input.name,
        input.description ?? null,
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
      { module: "manufacturing", action: "create", entityType: "route", entityId: id, newValues: input },
      nowIso,
    );

    return getRoute(db, id);
  })();
}

export function saveRouteOperation(
  db: SqliteDatabase,
  actor: AuditActor,
  input: SaveRouteOperationRequest,
  nowIso: string,
): RouteOperationDto {
  return db.transaction((): RouteOperationDto => {
    const route = db
      .prepare("SELECT id FROM manufacturing_routes WHERE id = ?")
      .get(input.routeId) as { id: number } | undefined;
    if (route === undefined) throw new RoutingError(`Route ${String(input.routeId)} was not found.`);

    let id = input.id;
    if (id === undefined) {
      const maxSeq = db
        .prepare(
          "SELECT COALESCE(MAX(sequence), 0) AS max_seq FROM manufacturing_route_operations WHERE route_id = ?",
        )
        .get(input.routeId) as { max_seq: number };
      const info = db
        .prepare(
          `INSERT INTO manufacturing_route_operations
             (route_id, operation_code, name, description, sequence, prerequisite_op_id,
              work_center_id, setup_time_minutes, cycle_time_minutes, expected_output_qty,
              labor_required, cost_rate_fils_per_hour, quality_checkpoint, work_instructions)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.routeId,
          input.operationCode,
          input.name,
          input.description ?? null,
          maxSeq.max_seq + 1,
          input.prerequisiteOpId ?? null,
          input.workCenterId ?? null,
          input.setupTimeMinutes ?? 0,
          input.cycleTimeMinutes ?? 0,
          input.expectedOutputQty ?? 1000,
          input.laborRequired ?? 1,
          input.costRateFilsPerHour ?? 0,
          input.qualityCheckpoint === true ? 1 : 0,
          input.workInstructions ?? null,
        );
      id = Number(info.lastInsertRowid);
    } else {
      db.prepare(
        `UPDATE manufacturing_route_operations
            SET operation_code = COALESCE(?, operation_code),
                name = COALESCE(?, name),
                description = COALESCE(?, description),
                sequence = COALESCE(?, sequence),
                prerequisite_op_id = COALESCE(?, prerequisite_op_id),
                work_center_id = COALESCE(?, work_center_id),
                setup_time_minutes = COALESCE(?, setup_time_minutes),
                cycle_time_minutes = COALESCE(?, cycle_time_minutes),
                expected_output_qty = COALESCE(?, expected_output_qty),
                labor_required = COALESCE(?, labor_required),
                cost_rate_fils_per_hour = COALESCE(?, cost_rate_fils_per_hour),
                quality_checkpoint = COALESCE(?, quality_checkpoint),
                work_instructions = COALESCE(?, work_instructions)
          WHERE id = ? AND route_id = ?`,
      ).run(
        input.operationCode ?? null,
        input.name ?? null,
        input.description ?? null,
        input.sequence ?? null,
        input.prerequisiteOpId ?? null,
        input.workCenterId ?? null,
        input.setupTimeMinutes ?? null,
        input.cycleTimeMinutes ?? null,
        input.expectedOutputQty ?? null,
        input.laborRequired ?? null,
        input.costRateFilsPerHour ?? null,
        input.qualityCheckpoint === undefined ? null : input.qualityCheckpoint ? 1 : 0,
        input.workInstructions ?? null,
        id,
        input.routeId,
      );
    }

    recordAudit(
      db,
      actor,
      {
        module: "manufacturing",
        action: input.id === undefined ? "create" : "update",
        entityType: "routeOperation",
        entityId: id,
        newValues: input,
      },
      nowIso,
    );

    const row = db
      .prepare(
        `SELECT o.*, p.name AS prerequisite_name, w.name AS work_center_name
           FROM manufacturing_route_operations o
           LEFT JOIN manufacturing_route_operations p ON p.id = o.prerequisite_op_id
           LEFT JOIN manufacturing_work_centers w ON w.id = o.work_center_id
          WHERE o.id = ?`,
      )
      .get(id) as RouteOperationRow | undefined;
    if (row === undefined) throw new RoutingError("The route operation could not be read back.");
    return mapRouteOperation(row);
  })();
}

function nextRouteNumber(db: SqliteDatabase): string {
  const row = db
    .prepare(
      "SELECT number FROM manufacturing_routes WHERE number LIKE 'RT-%' ORDER BY LENGTH(number) DESC, number DESC LIMIT 1",
    )
    .get() as { number?: string } | undefined;
  const last = row?.number === undefined ? 0 : Number.parseInt(row.number.slice(3), 10);
  return `RT-${String((Number.isFinite(last) ? last : 0) + 1).padStart(5, "0")}`;
}
