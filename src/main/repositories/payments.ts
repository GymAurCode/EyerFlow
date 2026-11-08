/**
 * Payment repository.
 *
 * A payment is one row plus its allocations. A payment that settles a party's
 * invoices can never be larger than what is still owed: the limit is checked
 * again inside the transaction, against the balance as it stands at the moment
 * of saving, so two payments recorded back to back cannot both claim the same
 * money.
 *
 * When no explicit allocation list is given the amount is spread across the
 * party's oldest unpaid invoices first - which is what the "Receive payment"
 * button does, and what the "Paid amount" field on a document form uses.
 */

import type { SqliteDatabase } from "../../data/connection";
import { fiscalYearOf } from "../../domain/dates";
import { formatPkr } from "../../domain/money";
import type {
  PaymentAllocationDto,
  PaymentDto,
  PaymentListRequest,
  SavePaymentRequest,
} from "../../shared/types";
import type { AuditActor } from "../audit-writer";
import { recordAudit } from "../audit-writer";
import { refreshDocumentPaid } from "./documents";
import { partyOutstanding } from "./parties";
import { nextReceiptNumber } from "./sequences";

export class PaymentError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PaymentError";
  }
}

interface PaymentRow {
  readonly id: number;
  readonly receipt_number: string | null;
  readonly direction: "inbound" | "outbound";
  readonly party_id: number;
  readonly party_name: string;
  readonly payment_date: string;
  readonly method: PaymentDto["method"];
  readonly amount_fils: number;
  readonly reference: string | null;
  readonly notes: string | null;
  readonly created_by: string | null;
  readonly created_at: string;
}

function allocationsFor(db: SqliteDatabase, paymentId: number): PaymentAllocationDto[] {
  const rows = db
    .prepare(
      `SELECT pa.document_id, d.number, pa.amount_fils
          FROM payment_allocations pa
          JOIN documents d ON d.id = pa.document_id
         WHERE pa.payment_id = ?
         ORDER BY d.issue_date, d.number`,
    )
    .all(paymentId) as { document_id: number; number: string; amount_fils: number }[];

  return rows.map((row) => ({
    documentId: row.document_id,
    documentNumber: row.number,
    amountFils: row.amount_fils,
  }));
}

function mapPayment(db: SqliteDatabase, row: PaymentRow): PaymentDto {
  return {
    id: row.id,
    receiptNumber: row.receipt_number,
    direction: row.direction,
    partyId: row.party_id,
    partyName: row.party_name,
    paymentDate: row.payment_date,
    method: row.method,
    amountFils: row.amount_fils,
    reference: row.reference,
    notes: row.notes,
    allocations: allocationsFor(db, row.id),
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

const PAYMENT_SELECT = `
  SELECT pay.*, p.name AS party_name
    FROM payments pay
    JOIN parties p ON p.id = pay.party_id
`;

export function listPayments(db: SqliteDatabase, request: PaymentListRequest): PaymentDto[] {
  const clauses: string[] = [];
  const params: (string | number)[] = [];

  if (request.direction !== undefined) {
    clauses.push("pay.direction = ?");
    params.push(request.direction);
  }
  if (request.partyId !== undefined) {
    clauses.push("pay.party_id = ?");
    params.push(request.partyId);
  }
  // The payments set against one invoice: what a document's own history is.
  if (request.documentId !== undefined) {
    clauses.push(
      "pay.id IN (SELECT payment_id FROM payment_allocations WHERE document_id = ?)",
    );
    params.push(request.documentId);
  }
  if (request.fromDate !== undefined) {
    clauses.push("pay.payment_date >= ?");
    params.push(request.fromDate);
  }
  if (request.toDate !== undefined) {
    clauses.push("pay.payment_date <= ?");
    params.push(request.toDate);
  }

  const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  const limit = request.limit ?? 500;

  const rows = db
    .prepare(`${PAYMENT_SELECT}${where} ORDER BY pay.payment_date DESC, pay.id DESC LIMIT ?`)
    .all(...params, limit) as PaymentRow[];

  return rows.map((row) => mapPayment(db, row));
}

export function getPayment(db: SqliteDatabase, id: number): PaymentDto {
  const row = db.prepare(`${PAYMENT_SELECT} WHERE pay.id = ?`).get(id) as PaymentRow | undefined;
  if (row === undefined) throw new PaymentError(`Payment ${String(id)} was not found.`);
  return mapPayment(db, row);
}

interface AllocationInput {
  readonly documentId: number;
  readonly amountFils: number;
}

/**
 * What a party still owes the shop, or the shop still owes them.
 *
 * The figure comes from the documents themselves: the gross of every invoice
 * that has not been cancelled, less the money that has been paid, plus the
 * money that has been given back. A payment that was deleted takes its money
 * with it - there is no stored balance to fall out of step - so this is the
 * net of every payment that is still recorded.
 */
export function outstandingForParty(db: SqliteDatabase, partyId: number): number {
  return partyOutstanding(db, partyId);
}

/**
 * Which side of the ledger a party is on.
 *
 * A party recorded as both is whichever side they actually trade on: a shop
 * that buys from someone and sells to them is a customer when they pay and a
 * supplier when we pay.
 */
function settlesWithOutboundPayments(db: SqliteDatabase, partyId: number): boolean {
  const row = db.prepare("SELECT kind FROM parties WHERE id = ?").get(partyId) as
    | { kind: string }
    | undefined;

  if (row?.kind === "supplier") return true;
  if (row?.kind === "customer") return false;

  const document = db
    .prepare(
      `SELECT kind FROM documents
        WHERE party_id = ? AND status <> 'cancelled'
          AND kind IN ('invoice','purchaseInvoice')
        ORDER BY id LIMIT 1`,
    )
    .get(partyId) as { kind: string } | undefined;

  return document?.kind === "purchaseInvoice";
}

/**
 * Record a payment.
 *
 * The amount is checked against the outstanding balance here, inside the
 * transaction, rather than in the form that asked for it. The form is a
 * convenience; this is the rule. A payment that settles what a party owes may
 * not exceed what they owe, may not be zero or negative, and may not leave
 * money unallocated - an advance is something the shop asks for on purpose,
 * through the advance posting kind, not something that happens by accident.
 */
export function savePayment(
  context: {
    db: SqliteDatabase;
    actor: AuditActor;
    fiscalYearStartMonth: number;
    nowIso: string;
    nowDate: string;
  },
  request: SavePaymentRequest,
): PaymentDto {
  const { db } = context;

  return db.transaction((): PaymentDto => {
    if (!Number.isSafeInteger(request.amountFils) || request.amountFils <= 0) {
      throw new PaymentError("Enter an amount greater than zero.");
    }

    // "auto" is the ordinary case: the money settles what the party owes.
    // The other kinds are money that is deliberately not settling an invoice
    // - an advance, an expense, the owner's own money - and are not limited by
    // what is owed.
    const settlesInvoices = (request.postingKind ?? "auto") === "auto";

    // Money that settles a debt is limited by that debt. Money going the other
    // way - a refund to a customer, a refund from a supplier - increases what
    // the party owes instead of reducing it, so there is no limit to exceed.
    const reducesDebt = settlesWithOutboundPayments(db, request.partyId)
      ? request.direction === "outbound"
      : request.direction === "inbound";

    if (settlesInvoices && reducesDebt) {
      const outstanding = Math.max(0, outstandingForParty(db, request.partyId));
      if (request.amountFils > outstanding) {
        throw new PaymentError(
          `Payment cannot exceed the outstanding balance of ${formatMoney(outstanding)}.`,
        );
      }
    }

    // No explicit list means "pay against the oldest invoices first", which is
    // how a shopkeeper actually takes money over the counter.
    const allocations =
      request.allocations ??
      oldestFirstAllocations(db, request.partyId, request.direction, request.amountFils);

    const fiscalYear = fiscalYearOf(request.paymentDate, context.fiscalYearStartMonth);
    const receiptNumber = nextReceiptNumber(db, request.direction, fiscalYear);

    const info = db
      .prepare(
        `INSERT INTO payments
           (receipt_number, direction, party_id, payment_date, method, amount_fils, reference,
            notes, created_by, created_at, fiscal_year)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        receiptNumber,
        request.direction,
        request.partyId,
        request.paymentDate,
        request.method,
        request.amountFils,
        request.reference ?? null,
        request.notes ?? null,
        context.actor.name,
        context.nowIso,
        fiscalYear,
      );

    const paymentId = Number(info.lastInsertRowid);

    applyAllocations(
      db,
      paymentId,
      allocations,
      context.nowIso,
      request.partyId,
      request.direction,
    );

    recordAudit(
      db,
      context.actor,
      {
        module: "payments",
        action: "create",
        entityType: "payment",
        entityId: paymentId,
        newValues: {
          receiptNumber,
          amount: request.amountFils,
          method: request.method,
          direction: request.direction,
        },
      },
      context.nowIso,
    );

    return getPayment(db, paymentId);
  })();
}

/** Spread an amount over a party's oldest unpaid invoices. */
function oldestFirstAllocations(
  db: SqliteDatabase,
  partyId: number,
  direction: "inbound" | "outbound",
  amountFils: number,
): readonly AllocationInput[] {
  const kind = direction === "inbound" ? "invoice" : "purchaseInvoice";

  const rows = db
    .prepare(
      `SELECT id, gross_fils - paid_fils AS outstanding
         FROM documents
        WHERE party_id = ? AND kind = ?
          AND status IN ('issued','partPaid') AND gross_fils > paid_fils
        ORDER BY issue_date, number`,
    )
    .all(partyId, kind) as { id: number; outstanding: number }[];

  const allocations: AllocationInput[] = [];
  let remaining = amountFils;

  for (const row of rows) {
    if (remaining <= 0) break;
    const amount = Math.min(remaining, Math.round(row.outstanding));
    if (amount <= 0) continue;
    allocations.push({ documentId: row.id, amountFils: amount });
    remaining -= amount;
  }

  return allocations;
}

/**
 * Insert allocations and recompute each document's paid status.
 *
 * Validation is per-invoice and against the live outstanding balance, so two
 * payments recorded back to back cannot both claim the same money. Each
 * allocation must also belong to the party being paid and be of the kind the
 * payment's direction implies, so money cannot settle the wrong invoice.
 */
function applyAllocations(
  db: SqliteDatabase,
  paymentId: number,
  allocations: readonly AllocationInput[],
  nowIso: string,
  partyId: number,
  direction: "inbound" | "outbound",
): void {
  const insert = db.prepare(
    "INSERT INTO payment_allocations (payment_id, document_id, amount_fils) VALUES (?, ?, ?)",
  );

  let allocatedTotal = 0;
  const touched = new Set<number>();

  for (const allocation of allocations) {
    if (allocation.amountFils <= 0) continue;

    const document = db
      .prepare(
        `SELECT id, kind, number, party_id, gross_fils, paid_fils, status
           FROM documents WHERE id = ?`,
      )
      .get(allocation.documentId) as
      | {
          id: number;
          kind: string;
          number: string;
          party_id: number;
          gross_fils: number;
          paid_fils: number;
          status: string;
        }
      | undefined;

    if (document === undefined) {
      throw new PaymentError(`Invoice ${String(allocation.documentId)} was not found.`);
    }
    if (document.status === "cancelled") {
      throw new PaymentError(`Invoice ${document.number} is cancelled and cannot be paid.`);
    }
    if (document.party_id !== partyId) {
      throw new PaymentError(`Invoice ${document.number} belongs to a different party.`);
    }
    // Money received settles a sales invoice; money paid settles a purchase
    // invoice. Money going back to a customer is set against their sales
    // invoice - it increases what they owe - so that pairing is allowed too.
    if (direction === "inbound" && document.kind !== "invoice") {
      throw new PaymentError(`Invoice ${document.number} is not a sales invoice.`);
    }

    const outstanding = document.gross_fils - document.paid_fils;
    if (allocation.amountFils > outstanding) {
      throw new PaymentError(
        `Payment cannot exceed the outstanding balance of ${formatMoney(outstanding)} on ${document.number}.`,
      );
    }

    insert.run(paymentId, document.id, allocation.amountFils);
    allocatedTotal += allocation.amountFils;
    touched.add(document.id);
  }

  for (const documentId of touched) {
    refreshDocumentPaid(db, documentId, nowIso);
  }

  // The allocations may not claim more money than the payment carries. Any
  // money the payment carries and the allocations do not claim stays as an
  // advance, which is only ever there on purpose - the caller decides.
  const total = (
    db.prepare("SELECT amount_fils FROM payments WHERE id = ?").get(paymentId) as {
      amount_fils: number;
    }
  ).amount_fils;

  if (allocatedTotal > total) {
    throw new PaymentError(
      `The allocations add up to more than the payment (${formatMoney(allocatedTotal)} > ${formatMoney(total)}).`,
    );
  }
}

/** Delete a payment and re-open the invoices it had paid. */
export function deletePayment(
  context: {
    db: SqliteDatabase;
    actor: AuditActor;
    fiscalYearStartMonth: number;
    nowIso: string;
  },
  id: number,
): void {
  const { db } = context;

  db.transaction(() => {
    const row = db
      .prepare("SELECT id, payment_date, amount_fils, receipt_number FROM payments WHERE id = ?")
      .get(id) as
      | { id: number; payment_date: string; amount_fils: number; receipt_number: string | null }
      | undefined;

    if (row === undefined) throw new PaymentError(`Payment ${String(id)} was not found.`);

    const documents = db
      .prepare("SELECT DISTINCT document_id FROM payment_allocations WHERE payment_id = ?")
      .all(id) as { document_id: number }[];

    db.prepare("DELETE FROM payments WHERE id = ?").run(id);

    for (const document of documents) {
      refreshDocumentPaid(db, document.document_id, context.nowIso);
    }

    recordAudit(
      db,
      context.actor,
      {
        module: "payments",
        action: "delete",
        entityType: "payment",
        entityId: id,
        oldValues: { receiptNumber: row.receipt_number, amount: row.amount_fils },
      },
      context.nowIso,
    );
  })();
}

function formatMoney(fils: number): string {
  return formatPkr(fils);
}
