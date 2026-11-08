/**
 * Quality Control repository.
 *
 * Real inspection records against a manufacturing order. A quality check is
 * created (pending) or resolved in one save: the caller supplies checkpoint,
 * inspection type, result and optionally the measured value, tolerances and
 * evidence reference.
 *
 * Two server-side rules matter beyond the INSERT:
 *  - The MO must exist. A check without a production order cannot exist.
 *  - `result='reworkRequired'` and 'rejected' are stored verbatim; the
 *    finished-goods receipt service reading these rows is what refuses to
 *    receive unapproved output (see finishedReceipts.ts).
 */

import type { SqliteDatabase } from "../../../data/connection";
import type { QualityCheckDto, QualityCheckListRequest, SaveQualityCheckRequest } from "../../../shared/types";
import type { AuditActor } from "../../audit-writer";
import { recordAudit } from "../../audit-writer";

export class QualityCheckError extends Error {
  public constructor(message: string, public readonly field?: string) {
    super(message);
    this.name = "QualityCheckError";
  }
}

interface QualityCheckRow {
  readonly id: number;
  readonly mo_id: number;
  readonly work_order_id: number | null;
  readonly checkpoint: string;
  readonly inspection_type: string;
  readonly result: string;
  readonly measured_value: string | null;
  readonly tolerance_min: string | null;
  readonly tolerance_max: string | null;
  readonly inspector_id: number | null;
  readonly inspected_at: string | null;
  readonly notes: string | null;
  readonly evidence_ref: string | null;
  readonly mo_number: string;
  readonly inspector_name: string | null;
}

function mapQualityCheck(row: QualityCheckRow): QualityCheckDto {
  return {
    id: row.id,
    moId: row.mo_id,
    moNumber: row.mo_number,
    workOrderId: row.work_order_id,
    checkpoint: row.checkpoint,
    inspectionType: row.inspection_type as QualityCheckDto["inspectionType"],
    result: row.result as QualityCheckDto["result"],
    measuredValue: row.measured_value,
    toleranceMin: row.tolerance_min,
    toleranceMax: row.tolerance_max,
    inspectorId: row.inspector_id,
    inspectorName: row.inspector_name,
    inspectedAt: row.inspected_at,
    notes: row.notes,
    evidenceRef: row.evidence_ref,
  };
}

const LIST_SELECT = `
  SELECT q.*, mo.number AS mo_number, u.display_name AS inspector_name
    FROM manufacturing_quality_checks q
    JOIN manufacturing_orders mo ON mo.id = q.mo_id
    LEFT JOIN users u ON u.id = q.inspector_id`;

export function listQualityChecks(
  db: SqliteDatabase,
  request: QualityCheckListRequest,
): QualityCheckDto[] {
  const clauses: string[] = ["1 = 1"];
  const params: (string | number)[] = [];

  if (request.moId !== undefined) {
    clauses.push("q.mo_id = ?");
    params.push(request.moId);
  }
  if (request.workOrderId !== undefined) {
    clauses.push("q.work_order_id = ?");
    params.push(request.workOrderId);
  }
  if (request.result !== undefined) {
    clauses.push("q.result = ?");
    params.push(request.result);
  }

  const where = ` WHERE ${clauses.join(" AND ")}`;
  const limit = request.limit ?? 500;

  const rows = db
    .prepare(`${LIST_SELECT}${where} ORDER BY q.inspected_at DESC, q.id DESC LIMIT ?`)
    .all(...params, limit) as QualityCheckRow[];

  return rows.map(mapQualityCheck);
}

export function saveQualityCheck(
  db: SqliteDatabase,
  actor: AuditActor,
  input: SaveQualityCheckRequest,
  nowIso: string,
): QualityCheckDto {
  return db.transaction(() : QualityCheckDto => {
    const mo = db
      .prepare("SELECT id, number FROM manufacturing_orders WHERE id = ?")
      .get(input.moId) as { id: number; number: string } | undefined;
    if (mo === undefined) {
      throw new QualityCheckError("The manufacturing order was not found.", "moId");
    }

    // A checkpoint is one inspection per MO/work-order combination: saving the
    // same checkpoint again updates the record rather than piling up rows.
    const existing = db
      .prepare(
        `SELECT id FROM manufacturing_quality_checks
          WHERE mo_id = ? AND checkpoint = ?
            AND ${input.workOrderId === null || input.workOrderId === undefined ? "work_order_id IS NULL" : "work_order_id = ?"}`,
      )
      // The trailing bind is only present when a work order is given.
      .get(
        ...(input.workOrderId === null || input.workOrderId === undefined
          ? [input.moId, input.checkpoint]
          : [input.moId, input.checkpoint, input.workOrderId]),
      ) as { id: number } | undefined;

    let id: number;
    if (existing !== undefined) {
      id = existing.id;
      db.prepare(
        `UPDATE manufacturing_quality_checks
            SET inspection_type = ?,
                result = ?,
                measured_value = ?,
                tolerance_min = ?,
                tolerance_max = ?,
                inspector_id = ?,
                inspected_at = ?,
                notes = ?,
                evidence_ref = ?
          WHERE id = ?`,
      ).run(
        input.inspectionType ?? "passFail",
        input.result ?? "pending",
        input.measuredValue ?? null,
        input.toleranceMin ?? null,
        input.toleranceMax ?? null,
        input.inspectorId ?? null,
        input.result === undefined ? null : nowIso,
        input.notes ?? null,
        input.evidenceRef ?? null,
        id,
      );
    } else {
      const info = db
        .prepare(
          `INSERT INTO manufacturing_quality_checks
             (mo_id, work_order_id, checkpoint, inspection_type, result,
              measured_value, tolerance_min, tolerance_max, inspector_id, inspected_at,
              notes, evidence_ref)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.moId,
          input.workOrderId ?? null,
          input.checkpoint,
          input.inspectionType ?? "passFail",
          input.result ?? "pending",
          input.measuredValue ?? null,
          input.toleranceMin ?? null,
          input.toleranceMax ?? null,
          input.inspectorId ?? null,
          input.result === undefined ? null : nowIso,
          input.notes ?? null,
          input.evidenceRef ?? null,
        );
      id = Number(info.lastInsertRowid);
    }

    recordAudit(
      db,
      actor,
      {
        module: "manufacturing",
        action: existing === undefined ? "create" : "update",
        entityType: "qualityCheck",
        entityId: id,
        newValues: input,
      },
      nowIso,
    );

    const row = db.prepare(`${LIST_SELECT} WHERE q.id = ?`).get(id) as
      | QualityCheckRow
      | undefined;
    if (row === undefined) {
      throw new QualityCheckError("The quality check could not be read back.");
    }

    // Failed output quarantines the MO into review so a receipt service gate
    // can reason about it; passing leaves the workflow unchanged.
    if (input.result === "failed" || input.result === "rejected") {
      db.prepare("UPDATE manufacturing_orders SET status = 'qualityReview', updated_at = ? WHERE id = ? AND status IN ('inProgress','qualityReview')").run(
        nowIso,
        input.moId,
      );
    }

    return mapQualityCheck(row);
  })();
}
