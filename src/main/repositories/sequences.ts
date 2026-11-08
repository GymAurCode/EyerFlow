/**
 * Document, payment and receipt number sequences.
 *
 * Sequences are per (kind, fiscal year) so the year rolls over cleanly and a
 * series is never reused. Numbers are allocated inside the caller's
 * transaction: SQLite serialises writes, so a concurrent second sale cannot be
 * handed the same number.
 */

import type { SqliteDatabase } from "../../data/connection";
import { type DocumentKind, DOCUMENT_PREFIXES, formatSequentialNumber } from "../../domain/returns";
/** Kinds that share the `documents` table, each with its own series. */
const DOCUMENT_KINDS: readonly DocumentKind[] = [
  "invoice",
  "quotation",
  "deliveryNote",
  "creditNote",
  "purchaseInvoice",
  "purchaseReturn",
  "stockAdjustment",
];

export function isDocumentKind(value: string): value is DocumentKind {
  return (DOCUMENT_KINDS as readonly string[]).includes(value);
}

/**
 * Allocate the next number in a series.
 *
 * Uses an upsert so the row is created on first use of the year, and reads
 * `last_used + 1` inside the same statement to keep the allocation atomic.
 *
 * The number carries the fiscal year - "INV-2026-0001" - because the series
 * restarts every year and a number that did not say which year it belonged
 * to would collide with the same number from the year before. That is not a
 * theoretical problem: a shop's first invoice of its second fiscal year would
 * otherwise be refused by the unique constraint on (kind, number).
 */
export function nextStockNumber(
  db: SqliteDatabase,
  kind: string,
  fiscalYear: number,
): string {
  if (!isDocumentKind(kind)) {
    throw new RangeError(`Unknown document kind: ${kind}`);
  }

  db.prepare(
    `INSERT INTO document_sequences (kind, fiscal_year, last_used)
     VALUES (?, ?, 0)
     ON CONFLICT (kind, fiscal_year) DO NOTHING`,
  ).run(kind, fiscalYear);

  db.prepare(
    "UPDATE document_sequences SET last_used = last_used + 1 WHERE kind = ? AND fiscal_year = ?",
  ).run(kind, fiscalYear);

  const row = db
    .prepare("SELECT last_used FROM document_sequences WHERE kind = ? AND fiscal_year = ?")
    .get(kind, fiscalYear) as { last_used: number };

  return formatDocumentNumber(DOCUMENT_PREFIXES[kind], fiscalYear, row.last_used);
}

/**
 * A document number: the prefix, the fiscal year it belongs to, and the
 * position in that year's series.
 */
export function formatDocumentNumber(prefix: string, fiscalYear: number, sequence: number): string {
  return `${prefix}-${String(fiscalYear)}-${String(sequence).padStart(4, "0")}`;
}

/** What the next number will be, without consuming it. */
export function peekStockNumber(
  db: SqliteDatabase,
  kind: string,
  fiscalYear: number,
): string {
  if (!isDocumentKind(kind)) {
    throw new RangeError(`Unknown document kind: ${kind}`);
  }
  const row = db
    .prepare("SELECT last_used FROM document_sequences WHERE kind = ? AND fiscal_year = ?")
    .get(kind, fiscalYear) as { last_used: number } | undefined;

  return formatSequentialNumber(DOCUMENT_PREFIXES[kind], (row?.last_used ?? 0) + 1);
}

const RECEIPT_PREFIX = { inbound: "RCP", outbound: "PAY" } as const;
type ReceiptDirection = keyof typeof RECEIPT_PREFIX;

/** Payment receipt numbers share the document_sequences table with a tag. */
const RECEIPT_KIND = { inbound: "receiptIn", outbound: "receiptOut" } as const;

export function nextReceiptNumber(
  db: SqliteDatabase,
  direction: ReceiptDirection,
  fiscalYear: number,
): string {
  const kind = RECEIPT_KIND[direction];

  db.prepare(
    `INSERT INTO document_sequences (kind, fiscal_year, last_used)
     VALUES (?, ?, 0) ON CONFLICT (kind, fiscal_year) DO NOTHING`,
  ).run(kind, fiscalYear);

  db.prepare(
    "UPDATE document_sequences SET last_used = last_used + 1 WHERE kind = ? AND fiscal_year = ?",
  ).run(kind, fiscalYear);

  const row = db
    .prepare("SELECT last_used FROM document_sequences WHERE kind = ? AND fiscal_year = ?")
    .get(kind, fiscalYear) as { last_used: number };

  return formatSequentialNumber(RECEIPT_PREFIX[direction], row.last_used);
}

export function peekReceiptNumber(
  db: SqliteDatabase,
  direction: ReceiptDirection,
  fiscalYear: number,
): string {
  const row = db
    .prepare("SELECT last_used FROM document_sequences WHERE kind = ? AND fiscal_year = ?")
    .get(RECEIPT_KIND[direction], fiscalYear) as { last_used: number } | undefined;

  return formatSequentialNumber(RECEIPT_PREFIX[direction], (row?.last_used ?? 0) + 1);
}

/**
 * Contract numbers (AMC / service agreements).
 *
 * Stored in the same sequence table under an `amc` tag so numbering stays
 * gap-free across the product without a second table.
 */
export function nextContractNumber(db: SqliteDatabase, fiscalYear: number): string {
  db.prepare(
    `INSERT INTO document_sequences (kind, fiscal_year, last_used)
     VALUES ('amc', ?, 0) ON CONFLICT (kind, fiscal_year) DO NOTHING`,
  ).run(fiscalYear);

  db.prepare(
    "UPDATE document_sequences SET last_used = last_used + 1 WHERE kind = 'amc' AND fiscal_year = ?",
  ).run(fiscalYear);

  const row = db
    .prepare("SELECT last_used FROM document_sequences WHERE kind = 'amc' AND fiscal_year = ?")
    .get(fiscalYear) as { last_used: number };

  return formatSequentialNumber("AMC", row.last_used);
}