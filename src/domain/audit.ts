/**
 * Tamper-evident audit log.
 *
 * Each entry stores the SHA-256 of (previous entry hash + this entry's
 * canonical payload). Changing or deleting any historical row breaks every hash
 * after it, and `verifyAuditChain` reports the first broken row. This does not
 * prevent a determined attacker with file access from recomputing the chain, but
 * it makes casual edits and accidental data loss detectable, which is the
 * realistic threat for a shop's till.
 */

import { createHash } from "node:crypto";

export interface AuditPayload {
  readonly module: string;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly actorId: number | null;
  readonly actorName: string;
  readonly oldValues: string | null;
  readonly newValues: string | null;
  readonly occurredAt: string;
}

/** Stable field order so the same data always produces the same hash. */
export function canonicalAuditPayload(payload: AuditPayload): string {
  return [
    payload.occurredAt,
    String(payload.actorId ?? ""),
    payload.actorName,
    payload.module,
    payload.action,
    payload.entityType,
    payload.entityId ?? "",
    payload.oldValues ?? "",
    payload.newValues ?? "",
  ].join("");
}

export function hashAuditEntry(prevHash: string, payload: AuditPayload): string {
  return createHash("sha256")
    .update(`${prevHash}${canonicalAuditPayload(payload)}`)
    .digest("hex");
}

/** Genesis link. Any constant works as long as it is never reused elsewhere. */
export const AUDIT_GENESIS_HASH = "0".repeat(64);

interface AuditChainRowShape {
  readonly id: number;
  readonly occurred_at: string;
  readonly actor_id: number | null;
  readonly actor_name: string;
  readonly module: string;
  readonly action: string;
  readonly entity_type: string;
  readonly entity_id: string | null;
  readonly old_values: string | null;
  readonly new_values: string | null;
  readonly prev_hash: string;
  readonly entry_hash: string;
}

export interface AuditChainVerification {
  readonly ok: boolean;
  readonly checkedRows: number;
  readonly brokenAtId: number | null;
  readonly message: string;
}

export function toAuditPayload(row: AuditRowLike): AuditPayload {
  return {
    occurredAt: row.occurred_at,
    actorId: row.actor_id,
    actorName: row.actor_name,
    module: row.module,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    oldValues: row.old_values,
    newValues: row.new_values,
  };
}

export interface AuditRowLike {
  readonly id: number;
  readonly occurred_at: string;
  readonly actor_id: number | null;
  readonly actor_name: string;
  readonly module: string;
  readonly action: string;
  readonly entity_type: string;
  readonly entity_id: string | null;
  readonly old_values: string | null;
  readonly new_values: string | null;
  readonly prev_hash: string;
  readonly entry_hash: string;
}

/**
 * Walk the chain in insertion order and recompute every hash.
 *
 * Reports the first id where the stored hash or the predecessor link no longer
 * matches, which is the row to investigate.
 */
export function verifyAuditChain(rows: readonly AuditRowLike[]): AuditChainVerification {
  let prev = AUDIT_GENESIS_HASH;

  for (const row of rows) {
    if (row.prev_hash !== prev) {
      return {
        ok: false,
        checkedRows: row.id,
        brokenAtId: row.id,
        message: `Audit chain broken at entry ${String(row.id)}: previous-hash link does not match.`,
      };
    }
    const expected = hashAuditEntry(prev, toAuditPayload(row));
    if (expected !== row.entry_hash) {
      return {
        ok: false,
        checkedRows: row.id,
        brokenAtId: row.id,
        message: `Audit chain broken at entry ${String(row.id)}: contents have been altered.`,
      };
    }
    prev = row.entry_hash;
  }

  return {
    ok: true,
    checkedRows: rows.length,
    brokenAtId: null,
    message:
      rows.length === 0
        ? "Audit log is empty; nothing to verify."
        : `Audit chain verified across ${String(rows.length)} entries.`,
  };
}

export type { AuditChainRowShape as AuditChainRow };