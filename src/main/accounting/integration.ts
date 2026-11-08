/**
 * Where the accounting engine meets the business records.
 *
 * The RPC layer is the one place every write in the app passes through, so the
 * posting is added there: the business write and its journal entry run inside
 * one transaction, so either both happen or neither does. A sale that saved but
 * did not post would leave the ledger short, and the reconciliation would find
 * it.
 *
 * The posting itself is `sync.ts`'s job, so every posting gets the same
 * treatment: a retried save changes nothing, and an edited record is corrected
 * by a reversal beside a replacement rather than by rewriting what was posted.
 *
 * Three rules govern what gets posted:
 *
 *  - A draft posts nothing. A quotation is not a transaction.
 *  - A cancelled document's posting is reversed, not deleted.
 *  - Money taken on the spot is a payment row, and the payment owns the cash
 *    movement. The document never touches cash.
 */

import type { SqliteDatabase } from "../../data/connection";
import type { DocumentDto, ExpenseDto, PaymentDto } from "../../shared/types";
import { reverseSource, syncEntry, type EntrySpec } from "./sync";
import {
  cashAccountFor,
  expenseEntrySpecs,
  partyKindOf,
  paymentEntrySpecs,
  purchaseEntrySpecs,
  saleEntrySpecs,
  type PartyKind,
  type PaymentPostingOptions,
} from "./service";
import { stockAdjustmentEntrySpecs } from "./returns";
import type { JournalEntryRecord, PostContext } from "./posting";

export interface AccountingContext extends PostContext {
  readonly nowDate: string;
}

function context(ctx: AccountingContext): PostContext & { partyKind(id: number): PartyKind } {
  return {
    db: ctx.db,
    nowIso: ctx.nowIso,
    createdBy: ctx.createdBy,
    partyKind: (id: number) => partyKindOf(ctx.db, id),
  };
}

/* -------------------------------------------------------------------------- */
/* documents                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The postings a document should have in force.
 *
 * The base keys are what identify a document's postings, and they are what a
 * reversal has to name, so they are built in one place and used by both.
 */
export function documentBaseKeys(document: Pick<DocumentDto, "id" | "kind">): readonly string[] {
  switch (document.kind) {
    case "purchaseInvoice":
      return [`purchase:${String(document.id)}`];
    case "stockAdjustment":
      return [`stock-adjustment:${String(document.id)}`];
    default:
      return [`sale:${String(document.id)}`, `sale-cogs:${String(document.id)}`];
  }
}

function documentSpecs(document: DocumentDto): readonly EntrySpec[] {
  switch (document.kind) {
    case "purchaseInvoice":
      return purchaseEntrySpecs(document);
    case "stockAdjustment":
      return stockAdjustmentEntrySpecs(document, document.costFils >= 0);
    default:
      return saleEntrySpecs(document, cashAccountFor("cash"));
  }
}

/**
 * Post a saved document, or reverse it if it should not be in the ledger.
 *
 * Called inside the same transaction as the document write.
 */
export function syncDocumentPosting(
  ctx: AccountingContext,
  document: DocumentDto,
): JournalEntryRecord[] {
  const c = context(ctx);
  const specs = documentSpecs(document);

  const postable =
    document.status !== "draft" &&
    document.status !== "cancelled" &&
    specs.some((spec) => spec.lines.length > 0);

  const results: JournalEntryRecord[] = [];

  if (!postable) {
    for (const spec of specs) {
      reverseSource(c, spec.baseKey, "The document is no longer posted", ctx.nowDate);
    }
    return results;
  }

  for (const spec of specs) {
    const entry = syncEntry(c, spec);
    if (entry !== null) results.push(entry);
  }

  // Money taken on the spot is a real payment row, and the payment owns the
  // cash movement. Posting it here keeps the cash side of the document in the
  // ledger without the document itself touching cash.
  syncPaymentsForDocument(ctx, document.id);

  return results;
}

/**
 * Post the payments allocated to a document.
 *
 * The app writes a payment row for money taken at the time of invoicing, and
 * later payments are allocated to it. Both are settled against the same
 * receivable or payable, so both are posted here.
 */
export function syncPaymentsForDocument(
  ctx: AccountingContext,
  documentId: number,
): JournalEntryRecord[] {
  const c = context(ctx);
  const payments = ctx.db
    .prepare(
      `SELECT p.id, p.direction, p.party_id AS partyId, p.payment_date AS paymentDate,
              p.method, p.amount_fils AS amountFils, p.reference, p.notes
         FROM payments p
         JOIN payment_allocations a ON a.payment_id = p.id
        WHERE a.document_id = ?
        ORDER BY p.id`,
    )
    .all(documentId) as PaymentDto[];

  const results: JournalEntryRecord[] = [];
  for (const payment of payments) {
    const spec = paymentEntrySpecs(payment, c.partyKind(payment.partyId), {
      allocatedFils: allocatedFilsFor(ctx.db, payment.id),
    })[0];
    if (spec === undefined) continue;
    const entry = syncEntry(c, spec);
    if (entry !== null) results.push(entry);
  }
  return results;
}

/**
 * How much of a payment was set against an invoice.
 *
 * The split matters: the part that settles an invoice reduces the control
 * account, and the part that is not set against anything is money paid or
 * received ahead of one, which is an advance. Without it, a customer who paid
 * too much would appear to have paid the invoice twice.
 */
function allocatedFilsFor(db: SqliteDatabase, paymentId: number): number {
  const row = db
    .prepare(
      "SELECT COALESCE(SUM(amount_fils), 0) AS total FROM payment_allocations WHERE payment_id = ?",
    )
    .get(paymentId) as { total: number };
  return row.total;
}

/**
 * Reverse a document's postings, for when the document is cancelled or deleted.
 *
 * The payments that settled it are deliberately left alone. Money that was
 * received is still received; what changes is that the invoice it was against
 * no longer exists, so the customer is left with a credit balance - which is
 * the honest description of "we took the money and then cancelled the sale".
 */
export function reverseDocumentPosting(
  ctx: AccountingContext,
  document: Pick<DocumentDto, "id" | "kind">,
  reason: string,
): void {
  const c = context(ctx);
  for (const baseKey of documentBaseKeys(document)) {
    reverseSource(c, baseKey, reason, ctx.nowDate);
  }
}

/* -------------------------------------------------------------------------- */
/* payments                                                                    */
/* -------------------------------------------------------------------------- */

export function syncPaymentPosting(
  ctx: AccountingContext,
  payment: PaymentDto,
  options?: PaymentPostingOptions,
): JournalEntryRecord | null {
  const c = context(ctx);
  const spec = paymentEntrySpecs(payment, c.partyKind(payment.partyId), {
    allocatedFils: allocatedFilsFor(ctx.db, payment.id),
    ...options,
  })[0];
  if (spec === undefined) return null;
  return syncEntry(c, spec);
}

/** Reverse a payment's posting. Used when the payment is deleted. */
export function reversePaymentPosting(ctx: AccountingContext, paymentId: number): void {
  reverseSource(
    context(ctx),
    `payment:${String(paymentId)}`,
    "The payment was deleted",
    ctx.nowDate,
  );
}

/* -------------------------------------------------------------------------- */
/* expenses                                                                    */
/* -------------------------------------------------------------------------- */

export function syncExpensePosting(
  ctx: AccountingContext,
  expense: ExpenseDto,
): JournalEntryRecord | null {
  const spec = expenseEntrySpecs(expense)[0];
  if (spec === undefined) return null;
  return syncEntry(context(ctx), spec);
}

export function reverseExpensePosting(ctx: AccountingContext, expenseId: number): void {
  reverseSource(
    context(ctx),
    `expense:${String(expenseId)}`,
    "The expense was deleted",
    ctx.nowDate,
  );
}
