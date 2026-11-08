/**
 * Work centers & equipment repository.
 *
 * Work centers are the production resources where operations run. Equipment
 * (machines) belongs to a work center. Maintenance status drives capacity
 * availability: a down work center blocks operations assigned to it.
 */

import type { SqliteDatabase } from "../../../data/connection";
import type {
  EquipmentDto,
  EquipmentListRequest,
  SaveEquipmentRequest,
  SaveWorkCenterRequest,
  WorkCenterDto,
  WorkCenterListRequest,
} from "../../../shared/types";
import type { AuditActor } from "../../audit-writer";
import { recordAudit } from "../../audit-writer";

export class WorkCenterError extends Error {
  public constructor(message: string, public readonly field?: string) {
    super(message);
    this.name = "WorkCenterError";
  }
}

interface WorkCenterRow {
  readonly id: number;
  readonly code: string;
  readonly name: string;
  readonly plant: string | null;
  readonly type: string;
  readonly capacity: number;
  readonly capacity_unit: string;
  readonly operating_schedule: string | null;
  readonly shift_id: number | null;
  readonly hourly_operating_cost_fils: number;
  readonly availability_pct: number;
  readonly efficiency_pct: number;
  readonly maintenance_status: string;
  readonly is_active: number;
  readonly created_at: string;
  readonly updated_at: string;
}

interface EquipmentRow {
  readonly id: number;
  readonly machine_code: string;
  readonly name: string;
  readonly work_center_id: number | null;
  readonly status: string;
  readonly capacity: number | null;
  readonly setup_time_minutes: number;
  readonly operating_rate_fils_per_hour: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly work_center_name: string | null;
}

function mapWorkCenter(row: WorkCenterRow): WorkCenterDto {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    plant: row.plant,
    type: row.type,
    capacity: row.capacity,
    capacityUnit: row.capacity_unit,
    operatingSchedule: row.operating_schedule,
    shiftId: row.shift_id,
    hourlyOperatingCostFils: row.hourly_operating_cost_fils,
    availabilityPct: row.availability_pct,
    efficiencyPct: row.efficiency_pct,
    maintenanceStatus: row.maintenance_status,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapEquipment(row: EquipmentRow): EquipmentDto {
  return {
    id: row.id,
    machineCode: row.machine_code,
    name: row.name,
    workCenterId: row.work_center_id,
    workCenterName: row.work_center_name,
    status: row.status,
    capacity: row.capacity,
    setupTimeMinutes: row.setup_time_minutes,
    operatingRateFilsPerHour: row.operating_rate_fils_per_hour,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listWorkCenters(
  db: SqliteDatabase,
  request: WorkCenterListRequest,
): WorkCenterDto[] {
  const clauses: string[] = ["1 = 1"];
  const params: (string | number)[] = [];

  if (request.isActive !== undefined) {
    clauses.push("w.is_active = ?");
    params.push(request.isActive ? 1 : 0);
  }
  if (request.search !== undefined && request.search.trim() !== "") {
    clauses.push("(w.code LIKE ? OR w.name LIKE ?)");
    const like = `%${request.search.trim()}%`;
    params.push(like, like);
  }

  const where = ` WHERE ${clauses.join(" AND ")}`;
  const limit = request.limit ?? 500;

  const rows = db
    .prepare(`SELECT * FROM manufacturing_work_centers w${where} ORDER BY w.name LIMIT ?`)
    .all(...params, limit) as WorkCenterRow[];

  return rows.map(mapWorkCenter);
}

export function saveWorkCenter(
  db: SqliteDatabase,
  actor: AuditActor,
  input: SaveWorkCenterRequest,
  nowIso: string,
): WorkCenterDto {
  return db.transaction((): WorkCenterDto => {
    if (input.id !== undefined) {
      const before = db
        .prepare("SELECT * FROM manufacturing_work_centers WHERE id = ?")
        .get(input.id) as Record<string, unknown> | undefined;
      if (before === undefined)
        throw new WorkCenterError(`Work center ${String(input.id)} was not found.`);

      db.prepare(
        `UPDATE manufacturing_work_centers
            SET code = COALESCE(?, code),
                name = COALESCE(?, name),
                plant = COALESCE(?, plant),
                type = COALESCE(?, type),
                capacity = COALESCE(?, capacity),
                capacity_unit = COALESCE(?, capacity_unit),
                operating_schedule = COALESCE(?, operating_schedule),
                shift_id = COALESCE(?, shift_id),
                hourly_operating_cost_fils = COALESCE(?, hourly_operating_cost_fils),
                availability_pct = COALESCE(?, availability_pct),
                efficiency_pct = COALESCE(?, efficiency_pct),
                maintenance_status = COALESCE(?, maintenance_status),
                is_active = COALESCE(?, is_active),
                updated_at = ?
          WHERE id = ?`,
      ).run(
        input.code ?? null,
        input.name ?? null,
        input.plant ?? null,
        input.type ?? null,
        input.capacity ?? null,
        input.capacityUnit ?? null,
        input.operatingSchedule ?? null,
        input.shiftId ?? null,
        input.hourlyOperatingCostFils ?? null,
        input.availabilityPct ?? null,
        input.efficiencyPct ?? null,
        input.maintenanceStatus ?? null,
        input.isActive === undefined ? null : input.isActive ? 1 : 0,
        nowIso,
        input.id,
      );

      recordAudit(
        db,
        actor,
        {
          module: "manufacturing",
          action: "update",
          entityType: "workCenter",
          entityId: input.id,
          oldValues: before,
          newValues: input,
        },
        nowIso,
      );

      return listWorkCenters(db, {}).find((wc) => wc.id === input.id) as WorkCenterDto;
    }

    const info = db
      .prepare(
        `INSERT INTO manufacturing_work_centers
           (code, name, plant, type, capacity, capacity_unit, operating_schedule,
            shift_id, hourly_operating_cost_fils, availability_pct, efficiency_pct,
            maintenance_status, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.code,
        input.name,
        input.plant ?? null,
        input.type ?? "assembly",
        input.capacity ?? 1,
        input.capacityUnit ?? "units_per_hour",
        input.operatingSchedule ?? null,
        input.shiftId ?? null,
        input.hourlyOperatingCostFils ?? 0,
        input.availabilityPct ?? 100,
        input.efficiencyPct ?? 100,
        input.maintenanceStatus ?? "operational",
        input.isActive === false ? 0 : 1,
        nowIso,
        nowIso,
      );

    const id = Number(info.lastInsertRowid);

    recordAudit(
      db,
      actor,
      { module: "manufacturing", action: "create", entityType: "workCenter", entityId: id, newValues: input },
      nowIso,
    );

    return listWorkCenters(db, {}).find((wc) => wc.id === id) as WorkCenterDto;
  })();
}

export function listEquipment(
  db: SqliteDatabase,
  request: EquipmentListRequest,
): EquipmentDto[] {
  const clauses: string[] = ["1 = 1"];
  const params: (string | number)[] = [];

  if (request.workCenterId !== undefined) {
    clauses.push("e.work_center_id = ?");
    params.push(request.workCenterId);
  }
  if (request.status !== undefined && request.status !== "") {
    clauses.push("e.status = ?");
    params.push(request.status);
  }
  if (request.search !== undefined && request.search.trim() !== "") {
    clauses.push("(e.machine_code LIKE ? OR e.name LIKE ?)");
    const like = `%${request.search.trim()}%`;
    params.push(like, like);
  }

  const where = ` WHERE ${clauses.join(" AND ")}`;
  const limit = request.limit ?? 500;

  const rows = db
    .prepare(
      `SELECT e.*, w.name AS work_center_name
         FROM manufacturing_equipment e
         LEFT JOIN manufacturing_work_centers w ON w.id = e.work_center_id
        ${where}
        ORDER BY e.machine_code LIMIT ?`,
    )
    .all(...params, limit) as EquipmentRow[];

  return rows.map(mapEquipment);
}

export function saveEquipment(
  db: SqliteDatabase,
  actor: AuditActor,
  input: SaveEquipmentRequest,
  nowIso: string,
): EquipmentDto {
  return db.transaction((): EquipmentDto => {
    let id = input.id;
    if (id === undefined) {
      const info = db
        .prepare(
          `INSERT INTO manufacturing_equipment
             (machine_code, name, work_center_id, status, capacity, setup_time_minutes,
              operating_rate_fils_per_hour, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.machineCode,
          input.name,
          input.workCenterId ?? null,
          input.status ?? "active",
          input.capacity ?? null,
          input.setupTimeMinutes ?? 0,
          input.operatingRateFilsPerHour ?? 0,
          nowIso,
          nowIso,
        );
      id = Number(info.lastInsertRowid);
    } else {
      db.prepare(
        `UPDATE manufacturing_equipment
            SET machine_code = COALESCE(?, machine_code),
                name = COALESCE(?, name),
                work_center_id = COALESCE(?, work_center_id),
                status = COALESCE(?, status),
                capacity = COALESCE(?, capacity),
                setup_time_minutes = COALESCE(?, setup_time_minutes),
                operating_rate_fils_per_hour = COALESCE(?, operating_rate_fils_per_hour),
                updated_at = ?
          WHERE id = ?`,
      ).run(
        input.machineCode ?? null,
        input.name ?? null,
        input.workCenterId ?? null,
        input.status ?? null,
        input.capacity ?? null,
        input.setupTimeMinutes ?? null,
        input.operatingRateFilsPerHour ?? null,
        nowIso,
        id,
      );
    }

    recordAudit(
      db,
      actor,
      {
        module: "manufacturing",
        action: input.id === undefined ? "create" : "update",
        entityType: "equipment",
        entityId: id,
        newValues: input,
      },
      nowIso,
    );

    return listEquipment(db, {}).find((e) => e.id === id) as EquipmentDto;
  })();
}
