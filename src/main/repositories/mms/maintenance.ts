/**
 * Maintenance request repository.
 *
 * Tracks maintenance requests for factory equipment.
 */

import type { SqliteDatabase } from "../../../data/connection";
import type { MaintenanceRequestDto, MaintenanceRequestListRequest, SaveMaintenanceRequestRequest } from "../../../shared/types";
import type { AuditActor } from "../../audit-writer";
import { recordAudit } from "../../audit-writer";

export class MaintenanceError extends Error {
  public constructor(message: string, public readonly field?: string) {
    super(message);
    this.name = "MaintenanceError";
  }
}

export function listMaintenanceRequests(
  db: SqliteDatabase,
  request: MaintenanceRequestListRequest,
): MaintenanceRequestDto[] {
  // Placeholder implementation
  return [];
}

export function saveMaintenanceRequest(
  db: SqliteDatabase,
  actor: AuditActor,
  input: SaveMaintenanceRequestRequest,
  nowIso: string,
): MaintenanceRequestDto {
  throw new MaintenanceError("Maintenance requests table not yet wired.");
}
