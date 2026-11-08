/**
 * Party (customer / supplier) repository.
 *
 * The balance shown on every screen is computed here from documents minus
 * payments rather than stored, so it can never drift out of step with the
 * ledger. The same formula backs the dashboard's receivables and payables.
 */

import type { SqliteDatabase } from "../../data/connection";
import type { PartyDto, PartyListRequest } from "../../shared/types";
import type { AuditActor } from "../audit-writer";
import { recordAudit } from "../audit-writer";

export class PartyError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PartyError";
  }
}

interface PartyRow {
  readonly id: number;
  readonly code: string;
  readonly name: string;
  readonly kind: "customer" | "supplier" | "both";
  readonly phone: string | null;
  readonly email: string | null;
  readonly trn: string | null;
  readonly address_line: string | null;
  readonly opening_balance: number;
  readonly is_active: number;
  readonly balance_fils: number;
}

/**
 * What the party still owes (customers) or is owed (suppliers), in fils.
 *
 * Positive means the party owes the shop. Computed on every read: a stored
 * balance would have to be kept in step by every write path, and the one path
 * that forgets is the one that shows a wrong number to a customer.
 *
 * Money given back to a party counts too. A refund to a customer increases
 * what the customer owes, and a refund from a supplier increases what the shop
 * owes, so both are added back rather than left out of the balance.
 */
const BALANCE_EXPRESSION = `
  p.opening_balance
  + COALESCE((
      SELECT SUM(CASE WHEN d.kind IN ('invoice','purchaseInvoice') THEN d.gross_fils ELSE 0 END)
        FROM documents d
       WHERE d.party_id = p.id AND d.status <> 'cancelled'
         AND d.kind IN ('invoice','purchaseInvoice')
    ), 0)
  - COALESCE((
      SELECT SUM(pay.amount_fils)
        FROM payments pay
       WHERE pay.party_id = p.id
         AND pay.direction = CASE WHEN p.kind = 'supplier' THEN 'outbound' ELSE 'inbound' END
    ), 0)
  + COALESCE((
      SELECT SUM(pay.amount_fils)
        FROM payments pay
       WHERE pay.party_id = p.id
         AND pay.direction = CASE WHEN p.kind = 'supplier' THEN 'inbound' ELSE 'outbound' END
    ), 0)
`;

const PARTY_SELECT = `
  SELECT p.*, ${BALANCE_EXPRESSION} AS balance_fils
    FROM parties p
`;

/**
 * What a party still owes the shop, or the shop still owes them.
 *
 * The same figure the party list shows, read for one party. Positive means
 * the party owes the shop. It is computed from the documents and the payments
 * every time it is asked for, so a payment that was deleted or a document
 * that was cancelled is already reflected in it.
 */
export function partyOutstanding(db: SqliteDatabase, partyId: number): number {
  const row = db
    .prepare(`SELECT ${BALANCE_EXPRESSION} AS balance FROM parties p WHERE p.id = ?`)
    .get(partyId) as { balance: number } | undefined;

  return row?.balance ?? 0;
}

function mapParty(row: PartyRow): PartyDto {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    kind: row.kind,
    phone: row.phone,
    email: row.email,
    trn: row.trn,
    addressLine: row.address_line,
    openingBalanceFils: row.opening_balance,
    isActive: row.is_active === 1,
    balanceFils: row.balance_fils,
  };
}

export function listParties(db: SqliteDatabase, request: PartyListRequest): PartyDto[] {
  const clauses: string[] = [];
  const params: (string | number)[] = [];

  if (request.kind !== undefined) {
    // "both" matches either role, so a customer who also supplies is findable.
    clauses.push("(p.kind = ? OR p.kind = 'both')");
    params.push(request.kind);
  }
  if (request.onlyActive === true) {
    clauses.push("p.is_active = 1");
  }
  if (request.search !== undefined && request.search.length > 0) {
    clauses.push("(p.name LIKE ? OR p.code LIKE ? OR p.phone LIKE ? OR p.trn LIKE ?)");
    const like = `%${request.search}%`;
    params.push(like, like, like, like);
  }

  const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  const limit = request.limit ?? 500;

  const rows = db
    .prepare(`${PARTY_SELECT}${where} ORDER BY p.name LIMIT ?`)
    .all(...params, limit) as PartyRow[];

  return rows.map(mapParty);
}

export function getParty(db: SqliteDatabase, id: number): PartyDto {
  const row = db.prepare(`${PARTY_SELECT} WHERE p.id = ?`).get(id) as PartyRow | undefined;
  if (row === undefined) throw new PartyError(`Customer or supplier ${String(id)} was not found.`);
  return mapParty(row);
}

function nextPartyCode(db: SqliteDatabase, kind: "customer" | "supplier" | "both"): string {
  const prefix = kind === "supplier" ? "SUP" : "CUS";
  const row = db
    .prepare(
      `SELECT code FROM parties
         WHERE code LIKE ? || '%'
         ORDER BY LENGTH(code) DESC, code DESC
         LIMIT 1`,
    )
    .get(`${prefix}-`) as { code?: string } | undefined;

  const lastNumber =
    row?.code === undefined ? 0 : Number.parseInt(row.code.slice(prefix.length + 1), 10);
  return `${prefix}-${String((Number.isFinite(lastNumber) ? lastNumber : 0) + 1).padStart(5, "0")}`;
}

export interface SavePartyInput {
  readonly id?: number;
  readonly name: string;
  readonly kind: "customer" | "supplier" | "both";
  readonly phone?: string | null;
  readonly email?: string | null;
  readonly trn?: string | null;
  readonly addressLine?: string | null;
  readonly isActive?: boolean;
}

export function saveParty(
  db: SqliteDatabase,
  actor: AuditActor,
  input: SavePartyInput,
  nowIso: string,
): PartyDto {
  return db.transaction((): PartyDto => {
    if (input.id !== undefined) {
      const before = db.prepare("SELECT * FROM parties WHERE id = ?").get(input.id) as
        | Record<string, unknown>
        | undefined;
      if (before === undefined) {
        throw new PartyError(`Customer or supplier ${String(input.id)} was not found.`);
      }

      const duplicate = db
        .prepare("SELECT id FROM parties WHERE name = ? AND id <> ?")
        .get(input.name, input.id) as { id?: number } | undefined;
      if (duplicate !== undefined) {
        throw new PartyError(`Another record is already named "${input.name}".`);
      }

      db.prepare(
        `UPDATE parties
            SET name = ?, kind = ?, phone = ?, email = ?, trn = ?, address_line = ?,
                is_active = ?, updated_at = ?
          WHERE id = ?`,
      ).run(
        input.name,
        input.kind,
        input.phone ?? null,
        input.email ?? null,
        input.trn ?? null,
        input.addressLine ?? null,
        input.isActive === false ? 0 : 1,
        nowIso,
        input.id,
      );

      recordAudit(
        db,
        actor,
        {
          module: "parties",
          action: "update",
          entityType: "party",
          entityId: input.id,
          oldValues: before,
          newValues: input,
        },
        nowIso,
      );

      return getParty(db, input.id);
    }

    const duplicate = db
      .prepare("SELECT id FROM parties WHERE name = ?")
      .get(input.name) as { id?: number } | undefined;
    if (duplicate !== undefined) {
      throw new PartyError(`"${input.name}" already exists. Open the existing record instead.`);
    }

    const code = nextPartyCode(db, input.kind);

    const info = db
      .prepare(
        `INSERT INTO parties
           (code, name, kind, phone, email, trn, address_line, opening_balance,
            is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      )
      .run(
        code,
        input.name,
        input.kind,
        input.phone ?? null,
        input.email ?? null,
        input.trn ?? null,
        input.addressLine ?? null,
        input.isActive === false ? 0 : 1,
        nowIso,
        nowIso,
      );

    const id = Number(info.lastInsertRowid);

    recordAudit(
      db,
      actor,
      { module: "parties", action: "create", entityType: "party", entityId: id, newValues: input },
      nowIso,
    );

    return getParty(db, id);
  })();
}

/**
 * Delete a customer or supplier that has no history.
 *
 * A party with invoices or payments against it cannot be removed: those
 * documents would point at nobody, and the ledger would stop adding up. The
 * caller is told to deactivate the record instead, which keeps it out of the
 * pickers while leaving the history intact.
 */
export function deleteParty(
  db: SqliteDatabase,
  actor: AuditActor,
  id: number,
  nowIso: string,
): void {
  db.transaction(() => {
    const row = db.prepare("SELECT id, name FROM parties WHERE id = ?").get(id) as
      | { id: number; name: string }
      | undefined;

    if (row === undefined) throw new PartyError(`Customer or supplier ${String(id)} was not found.`);

    const documents = db
      .prepare("SELECT COUNT(*) AS count FROM documents WHERE party_id = ?")
      .get(id) as { count: number };

    const payments = db
      .prepare("SELECT COUNT(*) AS count FROM payments WHERE party_id = ?")
      .get(id) as { count: number };

    if (documents.count > 0 || payments.count > 0) {
      throw new PartyError(
        `"${row.name}" has invoices or payments against it, so it cannot be deleted. ` +
          "Mark them inactive instead - the record will disappear from the pickers and the history stays intact.",
      );
    }

    db.prepare("DELETE FROM parties WHERE id = ?").run(id);

    recordAudit(
      db,
      actor,
      { module: "parties", action: "delete", entityType: "party", entityId: id },
      nowIso,
    );
  })();
}

/** Total outstanding for a direction, used by the dashboard tiles. */
export function totalOutstanding(
  db: SqliteDatabase,
  direction: "receivable" | "payable",
): number {
  const kind = direction === "receivable" ? "invoice" : "purchaseInvoice";
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(gross_fils - paid_fils), 0) AS total
         FROM documents
        WHERE kind = ?
          AND status IN ('issued','partPaid')
          AND gross_fils > paid_fils`,
    )
    .get(kind) as { total: number };

  return Math.round(row.total);
}
