/**
 * Audit trail writer.
 *
 * Every mutating RPC calls `recordAudit` inside the same transaction as the
 * change itself, so the log cannot claim something that was rolled back. The
 * hash chain is maintained here rather than by callers: making it automatic is
 * the only way to guarantee there are no unhashed rows.
 *
 * Migration 018 ("simplify to core inventory") dropped the `audit_log` table
 * along with the audit viewer, but every caller below survived it. Writing to a
 * table that is no longer there threw `no such table: audit_log` out of the
 * middle of each caller's transaction - which is why a brand-new install could
 * not be completed at all: `auth.setup` died with it and the wizard showed a
 * generic failure. So the writer checks, once per database, whether there is a
 * ledger to write to, and stays quiet when there is not.
 *
 * The check is cached per database handle because it cannot change while the
 * process runs: migrations always finish before any window opens.
 */

import type { SqliteDatabase } from "../data/connection";
import { AUDIT_GENESIS_HASH, type AuditPayload, hashAuditEntry } from "../domain/audit";

export interface AuditActor {
  readonly id: number | null;
  readonly name: string;
}

export const SYSTEM_ACTOR: AuditActor = { id: null, name: "System" };

/** Whether a ledger exists, per database handle. */
const ledgerPresence = new WeakMap<SqliteDatabase, boolean>();

/**
 * True when this database still carries an audit ledger.
 *
 * Reached through `sqlite_master` rather than by catching a failed prepare,
 * because a prepare that fails can leave a statement cached in a bad state, and
 * because "the table is not there" is an expected answer here, not an error.
 */
export function hasAuditLedger(db: SqliteDatabase): boolean {
  const known = ledgerPresence.get(db);
  if (known !== undefined) return known;

  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'audit_log'")
    .get() as { name?: unknown } | undefined;

  const present = row !== undefined;
  ledgerPresence.set(db, present);
  return present;
}

function lastHash(db: SqliteDatabase): string {
  const row = db.prepare("SELECT entry_hash FROM audit_log ORDER BY id DESC LIMIT 1").get() as
    { entry_hash?: unknown } | undefined;

  const value = row?.entry_hash;
  return typeof value === "string" ? value : AUDIT_GENESIS_HASH;
}

export interface AuditInput {
  readonly module: string;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string | number | null;
  readonly oldValues?: unknown;
  readonly newValues?: unknown;
  readonly summary?: string | null;
}

/**
 * Append one audit entry. Must be called inside the caller's transaction.
 *
 * Values are stored as JSON so the viewer can render a readable diff without
 * the main process needing to know every table's shape.
 *
 * A no-op on a database with no ledger, which after migration 018 is every
 * database. Callers keep their calls: the audit trail is a property of the
 * schema, not of the code that wants one.
 */
export function recordAudit(
  db: SqliteDatabase,
  actor: AuditActor,
  input: AuditInput,
  nowIso: string,
): void {
  if (!hasAuditLedger(db)) return;

  const entityId = input.entityId === null ? null : String(input.entityId);

  const payload: AuditPayload = {
    module: input.module,
    action: input.action,
    entityType: input.entityType,
    entityId,
    actorId: actor.id,
    actorName: actor.name,
    oldValues: input.oldValues === undefined ? null : JSON.stringify(input.oldValues),
    newValues: input.newValues === undefined ? null : JSON.stringify(input.newValues),
    occurredAt: nowIso,
  };

  const prevHash = lastHash(db);
  const entryHash = hashAuditEntry(prevHash, payload);

  db.prepare(
    `INSERT INTO audit_log
       (occurred_at, actor_id, actor_name, module, action, entity_type, entity_id,
        old_values, new_values, prev_hash, entry_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    nowIso,
    actor.id,
    actor.name,
    input.module,
    input.action,
    input.entityType,
    entityId,
    payload.oldValues,
    payload.newValues,
    prevHash,
    entryHash,
  );
}

/**
 * Human-readable one-line description for the audit viewer.
 *
 * Keeping this in the summary column avoids shipping the whole JSON payload to
 * the renderer just to render a list, which matters once the table is large.
 */
export function summarise(
  action: string,
  entityType: string,
  entityId: string | number | null,
): string {
  const label = entityType
    .replace(/([A-Z])/g, " $1")
    .trim()
    .toLowerCase();
  return `${action} ${label}${entityId === null ? "" : ` #${String(entityId)}`}`;
}
