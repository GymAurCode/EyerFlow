/**
 * WIP repository.
 *
 * Tracks Work-in-Progress quantities and status.
 */

import type { SqliteDatabase } from "../../../data/connection";
import type { WipRecordDto, WipListRequest } from "../../../shared/types";

export function listWipRecords(
  db: SqliteDatabase,
  request: WipListRequest,
): WipRecordDto[] {
  // Placeholder implementation
  return [];
}
