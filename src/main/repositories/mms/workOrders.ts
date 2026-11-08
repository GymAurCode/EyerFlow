/**
 * Work order repository.
 *
 * Work orders break a manufacturing order into operations. Each work order
 * references an operation, work center, and operator. States flow:
 * blocked → ready → inProgress → paused → completed, with hold/cancelled as
 * controlled exits. A later operation cannot start before its prerequisite
 * work order is completed unless an override is approved.
 *
 * Time is persisted server-side (job_time_logs); the browser timer is never
 * the authoritative duration.
 */

import type { SqliteDatabase } from "../../../data/connection";
import type {
  JobTimeLogDto,
  SaveJobTimeLogRequest,
  SaveWorkOrderRequest,
  WorkOrderDto,
  WorkOrderListRequest,
} from "../../../shared/types";
import type { AuditActor } from "../../audit-writer";
import { recordAudit } from "../../audit-writer";
import { defaultLocationId } from "../ims/stock";

export class WorkOrderError extends Error {
  public constructor(message: string, public readonly field?: string) {
    super(message);
    this.name = "WorkOrderError";
  }
}

interface WorkOrderRow {
  readonly id: number;
  readonly mo_id: number;
  readonly route_operation_id: number;
  readonly work_center_id: number | null;
  readonly operator_id: number | null;
  readonly planned_quantity: number;
  readonly actual_quantity: number;
  readonly accepted_quantity: number;
  readonly rejected_quantity: number;
  readonly expected_duration_minutes: number;
  readonly actual_duration_minutes: number;
  readonly status: string;
  readonly started_at: string | null;
  readonly completed_at: string | null;
  readonly planned_start: string | null;
  readonly planned_finish: string | null;
  readonly notes: string | null;
  readonly mo_number: string;
  readonly operation_code: string;
  readonly operation_name: string;
  readonly work_center_name: string | null;
  readonly operator_name: string | null;
  readonly prerequisite_op_id: number | null;
}

interface JobTimeLogRow {
  readonly id: number;
  readonly work_order_id: number;
  readonly operator_id: number | null;
  readonly started_at: string;
  readonly ended_at: string | null;
  readonly duration_minutes: number;
  readonly downtime_minutes: number;
  readonly downtime_reason: string | null;
  readonly created_at: string;
  readonly operator_name: string | null;
}

function mapWorkOrder(row: WorkOrderRow): WorkOrderDto {
  return {
    id: row.id,
    moId: row.mo_id,
    moNumber: row.mo_number,
    routeOperationId: row.route_operation_id,
    operationCode: row.operation_code,
    operationName: row.operation_name,
    workCenterId: row.work_center_id,
    workCenterName: row.work_center_name,
    operatorId: row.operator_id,
    operatorName: row.operator_name,
    plannedQuantity: row.planned_quantity,
    actualQuantity: row.actual_quantity,
    acceptedQuantity: row.accepted_quantity,
    rejectedQuantity: row.rejected_quantity,
    expectedDurationMinutes: row.expected_duration_minutes,
    actualDurationMinutes: row.actual_duration_minutes,
    status: row.status as WorkOrderDto["status"],
    startedAt: row.started_at,
    completedAt: row.completed_at,
    plannedStart: row.planned_start,
    plannedFinish: row.planned_finish,
    notes: row.notes,
  };
}

function mapJobTimeLog(row: JobTimeLogRow): JobTimeLogDto {
  return {
    id: row.id,
    workOrderId: row.work_order_id,
    operatorId: row.operator_id,
    operatorName: row.operator_name,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationMinutes: row.duration_minutes,
    downtimeMinutes: row.downtime_minutes,
    downtimeReason: row.downtime_reason,
    createdAt: row.created_at,
  };
}

export function listWorkOrders(
  db: SqliteDatabase,
  request: WorkOrderListRequest,
): WorkOrderDto[] {
  const clauses: string[] = ["1 = 1"];
  const params: (string | number)[] = [];

  if (request.moId !== undefined) {
    clauses.push("wo.mo_id = ?");
    params.push(request.moId);
  }
  if (request.workCenterId !== undefined) {
    clauses.push("wo.work_center_id = ?");
    params.push(request.workCenterId);
  }
  if (request.status !== undefined) {
    clauses.push("wo.status = ?");
    params.push(request.status);
  }
  if (request.operatorId !== undefined) {
    clauses.push("wo.operator_id = ?");
    params.push(request.operatorId);
  }

  const where = ` WHERE ${clauses.join(" AND ")}`;
  const limit = request.limit ?? 500;

  const rows = db
    .prepare(
      `SELECT wo.*, mo.number AS mo_number, o.operation_code, o.name AS operation_name,
              w.name AS work_center_name, u.display_name AS operator_name,
              o.prerequisite_op_id
         FROM manufacturing_work_orders wo
         JOIN manufacturing_orders mo ON mo.id = wo.mo_id
         JOIN manufacturing_route_operations o ON o.id = wo.route_operation_id
         LEFT JOIN manufacturing_work_centers w ON w.id = wo.work_center_id
         LEFT JOIN users u ON u.id = wo.operator_id
        ${where}
        ORDER BY wo.id DESC
        LIMIT ?`,
    )
    .all(...params, limit) as WorkOrderRow[];

  return rows.map(mapWorkOrder);
}

export function getWorkOrder(db: SqliteDatabase, id: number): WorkOrderDto {
  const row = db
    .prepare(
      `SELECT wo.*, mo.number AS mo_number, o.operation_code, o.name AS operation_name,
              w.name AS work_center_name, u.display_name AS operator_name,
              o.prerequisite_op_id
         FROM manufacturing_work_orders wo
         JOIN manufacturing_orders mo ON mo.id = wo.mo_id
         JOIN manufacturing_route_operations o ON o.id = wo.route_operation_id
         LEFT JOIN manufacturing_work_centers w ON w.id = wo.work_center_id
         LEFT JOIN users u ON u.id = wo.operator_id
        WHERE wo.id = ?`,
    )
    .get(id) as WorkOrderRow | undefined;
  if (row === undefined) throw new WorkOrderError(`Work order ${String(id)} was not found.`);

  return mapWorkOrder(row);
}

export function saveWorkOrder(
  db: SqliteDatabase,
  actor: AuditActor,
  input: SaveWorkOrderRequest,
  nowIso: string,
): WorkOrderDto {
  return db.transaction((): WorkOrderDto => {
    if (input.id !== undefined) {
      const before = db
        .prepare("SELECT * FROM manufacturing_work_orders WHERE id = ?")
        .get(input.id) as Record<string, unknown> | undefined;
      if (before === undefined)
        throw new WorkOrderError(`Work order ${String(input.id)} was not found.`);

      // `manufacturing_work_orders` carries no updated_at column, and the work
      // order DTO does not expose one either, so the row's own state columns are
      // the whole update.
      db.prepare(
        `UPDATE manufacturing_work_orders
            SET work_center_id = COALESCE(?, work_center_id),
                operator_id = COALESCE(?, operator_id),
                planned_quantity = COALESCE(?, planned_quantity),
                status = COALESCE(?, status),
                notes = COALESCE(?, notes)
          WHERE id = ?`,
      ).run(
        input.workCenterId ?? null,
        input.operatorId ?? null,
        input.plannedQuantity ?? null,
        input.status ?? null,
        input.notes ?? null,
        input.id,
      );

      recordAudit(
        db,
        actor,
        {
          module: "manufacturing",
          action: "update",
          entityType: "workOrder",
          entityId: input.id,
          oldValues: before,
          newValues: input,
        },
        nowIso,
      );

      return getWorkOrder(db, input.id);
    }

    // Validate prerequisite: the MO must exist and the operation's prerequisite
    // (if any) must be completed before this work order can be ready.
    const op = db
      .prepare(
        `SELECT o.prerequisite_op_id, o.name AS operation_name
           FROM manufacturing_route_operations o
           WHERE o.id = ?`,
      )
      .get(input.routeOperationId) as {
      prerequisite_op_id: number | null;
      operation_name: string;
    } | undefined;
    if (op === undefined) throw new WorkOrderError("The route operation was not found.");

    let status = "blocked";
    if (op.prerequisite_op_id === null) {
      status = "ready";
    } else {
      const prereqWo = db
        .prepare(
          `SELECT wo.status FROM manufacturing_work_orders wo
            JOIN manufacturing_route_operations po ON po.id = wo.route_operation_id
           WHERE wo.mo_id = ? AND po.prerequisite_op_id IS NULL AND po.id = ?`,
        )
        .get(input.moId, op.prerequisite_op_id) as { status: string } | undefined;
      // Find the work order for the prerequisite operation.
      const prereqWo2 = db
        .prepare(
          "SELECT status FROM manufacturing_work_orders WHERE mo_id = ? AND route_operation_id = ?",
        )
        .get(input.moId, op.prerequisite_op_id) as { status: string } | undefined;
      if (prereqWo2 !== undefined && prereqWo2.status === "completed") {
        status = "ready";
      }
    }

    const info = db
      .prepare(
        `INSERT INTO manufacturing_work_orders
           (mo_id, route_operation_id, work_center_id, operator_id, planned_quantity,
            status, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.moId,
        input.routeOperationId,
        input.workCenterId ?? null,
        input.operatorId ?? null,
        input.plannedQuantity ?? 0,
        status,
        input.notes ?? null,
      );

    const id = Number(info.lastInsertRowid);

    recordAudit(
      db,
      actor,
      {
        module: "manufacturing",
        action: "create",
        entityType: "workOrder",
        entityId: id,
        newValues: { moId: input.moId, routeOperationId: input.routeOperationId, status },
      },
      nowIso,
    );

    return getWorkOrder(db, id);
  })();
}

export function startWorkOrder(
  db: SqliteDatabase,
  actor: AuditActor,
  id: number,
  nowIso: string,
): WorkOrderDto {
  return db.transaction((): WorkOrderDto => {
    const wo = getWorkOrder(db, id);
    if (wo.status !== "ready") {
      throw new WorkOrderError(
        `Only a ready work order can be started. Current status: ${wo.status}.`,
      );
    }

    // Prevent overlapping active timers for the same operator.
    if (wo.operatorId !== null) {
      const active = db
        .prepare(
          `SELECT wo.id FROM manufacturing_work_orders wo
            JOIN manufacturing_job_time_logs jtl ON jtl.work_order_id = wo.id
           WHERE wo.operator_id = ? AND wo.status = 'inProgress'
             AND (jtl.ended_at IS NULL OR jtl.ended_at = '')
             AND wo.id <> ?`,
        )
        .get(wo.operatorId, id) as { id: number } | undefined;
      if (active !== undefined) {
        throw new WorkOrderError(
          `Operator already has an active work order (${String(active.id)}). Complete or pause it first.`,
        );
      }
    }

    db.prepare(
      "UPDATE manufacturing_work_orders SET status = 'inProgress', started_at = ? WHERE id = ?",
    ).run(nowIso, id);

    // Starting work is what moves a released order into production. Without
    // this the MO sat at `released` forever, so the dashboard could not tell
    // work had begun and the order never reached quality review.
    db.prepare(
      `UPDATE manufacturing_orders
          SET status = 'inProgress',
              actual_start = COALESCE(actual_start, ?),
              updated_at = ?
        WHERE id = ? AND status = 'released'`,
    ).run(nowIso, nowIso, wo.moId);

    // Open a time log.
    db.prepare(
      `INSERT INTO manufacturing_job_time_logs
         (work_order_id, operator_id, started_at, duration_minutes, downtime_minutes, created_at)
       VALUES (?, ?, ?, 0, 0, ?)`,
    ).run(id, wo.operatorId ?? null, nowIso, nowIso);

    recordAudit(
      db,
      actor,
      { module: "manufacturing", action: "start", entityType: "workOrder", entityId: id },
      nowIso,
    );

    return getWorkOrder(db, id);
  })();
}

export function pauseWorkOrder(
  db: SqliteDatabase,
  actor: AuditActor,
  id: number,
  nowIso: string,
): WorkOrderDto {
  return db.transaction((): WorkOrderDto => {
    const wo = getWorkOrder(db, id);
    if (wo.status !== "inProgress") {
      throw new WorkOrderError(`Only an in-progress work order can be paused. Current: ${wo.status}.`);
    }

    // Close the current open time log.
    db.prepare(
      `UPDATE manufacturing_job_time_logs
         SET ended_at = ?, duration_minutes = CAST((julianday(ended_at) - julianday(started_at)) * 1440 AS INTEGER)
       WHERE work_order_id = ? AND ended_at IS NULL`,
    ).run(nowIso, id);

    db.prepare(
      "UPDATE manufacturing_work_orders SET status = 'paused' WHERE id = ?",
    ).run(id);

    recordAudit(
      db,
      actor,
      { module: "manufacturing", action: "pause", entityType: "workOrder", entityId: id },
      nowIso,
    );

    return getWorkOrder(db, id);
  })();
}

export function resumeWorkOrder(
  db: SqliteDatabase,
  actor: AuditActor,
  id: number,
  nowIso: string,
): WorkOrderDto {
  return db.transaction((): WorkOrderDto => {
    const wo = getWorkOrder(db, id);
    if (wo.status !== "paused") {
      throw new WorkOrderError(`Only a paused work order can be resumed. Current: ${wo.status}.`);
    }

    // Prevent overlapping active timers for the same operator.
    if (wo.operatorId !== null) {
      const active = db
        .prepare(
          `SELECT wo.id FROM manufacturing_work_orders wo
            JOIN manufacturing_job_time_logs jtl ON jtl.work_order_id = wo.id
           WHERE wo.operator_id = ? AND wo.status = 'inProgress'
             AND (jtl.ended_at IS NULL OR jtl.ended_at = '')
             AND wo.id <> ?`,
        )
        .get(wo.operatorId, id) as { id: number } | undefined;
      if (active !== undefined) {
        throw new WorkOrderError(
          `Operator already has an active work order (${String(active.id)}).`,
        );
      }
    }

    db.prepare(
      "UPDATE manufacturing_work_orders SET status = 'inProgress' WHERE id = ?",
    ).run(id);

    db.prepare(
      `INSERT INTO manufacturing_job_time_logs
         (work_order_id, operator_id, started_at, duration_minutes, downtime_minutes, created_at)
       VALUES (?, ?, ?, 0, 0, ?)`,
    ).run(id, wo.operatorId ?? null, nowIso, nowIso);

    recordAudit(
      db,
      actor,
      { module: "manufacturing", action: "resume", entityType: "workOrder", entityId: id },
      nowIso,
    );

    return getWorkOrder(db, id);
  })();
}

export function completeWorkOrder(
  db: SqliteDatabase,
  actor: AuditActor,
  id: number,
  actualQuantity: number,
  acceptedQuantity: number,
  rejectedQuantity: number,
  nowIso: string,
): WorkOrderDto {
  return db.transaction((): WorkOrderDto => {
    const wo = getWorkOrder(db, id);
    if (wo.status !== "inProgress") {
      throw new WorkOrderError(
        `Only an in-progress work order can be completed. Current: ${wo.status}.`,
      );
    }
    if (actualQuantity <= 0) {
      throw new WorkOrderError("Actual quantity must be greater than zero.");
    }
    if (acceptedQuantity + rejectedQuantity > actualQuantity) {
      throw new WorkOrderError("Accepted plus rejected cannot exceed actual quantity.");
    }

    // Close the current open time log and accumulate duration.
    // The elapsed time is measured against the timestamp being written, not the
    // row's current `ended_at`: SQLite evaluates both SET expressions against
    // the old row, so the old (NULL) `ended_at` made the duration NULL and the
    // NOT NULL constraint on duration_minutes failed the whole completion.
    db.prepare(
      `UPDATE manufacturing_job_time_logs
         SET duration_minutes = COALESCE(duration_minutes, 0) +
               CAST(COALESCE((julianday(?) - julianday(started_at)) * 1440, 0) AS INTEGER),
             ended_at = ?
       WHERE work_order_id = ? AND ended_at IS NULL`,
    ).run(nowIso, nowIso, id);

    // Recompute total actual duration from all time logs.
    const totalDuration = db
      .prepare(
        "SELECT COALESCE(SUM(duration_minutes), 0) AS total FROM manufacturing_job_time_logs WHERE work_order_id = ?",
      )
      .get(id) as { total: number };

    db.prepare(
      `UPDATE manufacturing_work_orders
          SET status = 'completed',
              actual_quantity = ?,
              accepted_quantity = ?,
              rejected_quantity = ?,
              actual_duration_minutes = ?,
              completed_at = ?
        WHERE id = ?`,
    ).run(
      actualQuantity,
      acceptedQuantity,
      rejectedQuantity,
      totalDuration.total,
      nowIso,
      id,
    );

    // Roll the work order up into its manufacturing order.
    //
    // The MO is the document a finished-goods receipt reads, and a receipt is
    // only allowed once the order reports produced quantity. Nothing used to
    // write `actual_quantity` on the MO, so every receipt was refused with
    // "only 0 units remain un-received" and the finished product never reached
    // IMS stock. Recomputing from the completed work orders keeps the MO's
    // totals equal to the sum of its operations, however the work was split.
    const rollup = db
      .prepare(
        `SELECT COALESCE(SUM(actual_quantity), 0)   AS actual,
                COALESCE(SUM(rejected_quantity), 0) AS rejected,
                COUNT(*)                            AS total,
                SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed
           FROM manufacturing_work_orders
          WHERE mo_id = ?`,
      )
      .get(wo.moId) as {
      actual: number;
      rejected: number;
      total: number;
      completed: number;
    };

    const allCompleted = rollup.completed >= rollup.total;
    db.prepare(
      `UPDATE manufacturing_orders
          SET actual_quantity = ?,
              rejected_quantity = ?,
              status = ?,
              actual_start = COALESCE(actual_start, ?),
              actual_finish = ?,
              updated_at = ?
        WHERE id = ?`,
    ).run(
      rollup.actual,
      rollup.rejected,
      allCompleted ? "qualityReview" : "inProgress",
      nowIso,
      allCompleted ? nowIso : null,
      nowIso,
      wo.moId,
    );

    recordAudit(
      db,
      actor,
      {
        module: "manufacturing",
        action: "complete",
        entityType: "workOrder",
        entityId: id,
        newValues: {
          actualQuantity,
          acceptedQuantity,
          rejectedQuantity,
          durationMinutes: totalDuration.total,
        },
      },
      nowIso,
    );

    return getWorkOrder(db, id);
  })();
}

export function saveJobTimeLog(
  db: SqliteDatabase,
  actor: AuditActor,
  input: SaveJobTimeLogRequest,
  nowIso: string,
): JobTimeLogDto {
  return db.transaction((): JobTimeLogDto => {
    const wo = db
      .prepare("SELECT operator_id, status FROM manufacturing_work_orders WHERE id = ?")
      .get(input.workOrderId) as {
      operator_id: number | null;
      status: string;
    } | undefined;
    if (wo === undefined) throw new WorkOrderError("The work order was not found.");

    const duration = input.endedAt !== undefined && input.endedAt !== null
      ? Math.round(
          (new Date(input.endedAt).getTime() - new Date(input.startedAt).getTime()) / 60000,
        )
      : 0;

    const info = db
      .prepare(
        `INSERT INTO manufacturing_job_time_logs
           (work_order_id, operator_id, started_at, ended_at, duration_minutes,
            downtime_minutes, downtime_reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.workOrderId,
        input.operatorId ?? null,
        input.startedAt,
        input.endedAt ?? null,
        duration,
        input.downtimeMinutes ?? 0,
        input.downtimeReason ?? null,
        nowIso,
      );

    const id = Number(info.lastInsertRowid);

    recordAudit(
      db,
      actor,
      { module: "manufacturing", action: "logTime", entityType: "jobTimeLog", entityId: id },
      nowIso,
    );

    const row = db
      .prepare(
        `SELECT jtl.*, u.display_name AS operator_name
           FROM manufacturing_job_time_logs jtl
           LEFT JOIN users u ON u.id = jtl.operator_id
          WHERE jtl.id = ?`,
      )
      .get(id) as JobTimeLogRow | undefined;
    if (row === undefined) throw new WorkOrderError("The time log could not be read back.");
    return mapJobTimeLog(row);
  })();
}

export function listJobTimeLogs(
  db: SqliteDatabase,
  workOrderId: number,
): JobTimeLogDto[] {
  const rows = db
    .prepare(
      `SELECT jtl.*, u.display_name AS operator_name
         FROM manufacturing_job_time_logs jtl
         LEFT JOIN users u ON u.id = jtl.operator_id
        WHERE jtl.work_order_id = ?
        ORDER BY jtl.started_at DESC`,
    )
    .all(workOrderId) as JobTimeLogRow[];

  return rows.map(mapJobTimeLog);
}
