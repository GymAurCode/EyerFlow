/**
 * Keeping the ledger in step with the business records.
 *
 * A journal entry is a fact. A sale invoice is a fact that can change: the
 * customer might be wrong about the quantity, the shopkeeper might notice the
 * discount was mistyped. When that happens the posting has to change too - but
 * a posted entry is never rewritten, because a financial record that can be
 * silently overwritten is not a record.
 *
 * So the rule here is: **a correction is a reversal followed by a replacement.**
 * The old entry stays, marked reversed, and the new one is posted beside it.
 * The reader of the journal sees both, which is what an auditor expects.
 *
 * Three properties make this safe:
 *
 *  1. **Idempotency by content.** Before posting, the desired entry is
 *     compared with the one already in force. If they are the same, nothing
 *     happens. That is what makes a retried save safe: the second attempt
 *     finds the entry it wrote the first time and leaves it alone.
 *
 *  2. **Revisioned source keys.** Each posting of a business record carries a
 *     key derived from the record's id ("sale:41", then "sale:41:2" for the
 *     correction). The key is UNIQUE, so two entries can never claim the same
 *     origin, and the history of corrections is still traceable.
 *
 *  3. **One transaction.** The business write and its posting run inside the
 *     same database transaction, so a failure leaves neither half behind.
 */

import type { SqliteDatabase } from "../../data/connection";
import type { Fils } from "../../domain/money";
import {
  activeEntryForSource,
  nextSourceKey,
  postEntry,
  reverseEntry,
  type JournalEntryInput,
  type JournalEntryRecord,
  type JournalSource,
  type PostContext,
} from "./posting";

/** One posting, described independently of whether it has been written yet. */
export interface EntrySpec {
  /**
   * The origin of the posting, e.g. "sale:41". Revisions get a suffix, so
   * "sale:41" is the first posting of sale 41 and "sale:41:2" its correction.
   */
  readonly baseKey: string;
  readonly entryDate: string;
  readonly description: string;
  readonly source: JournalSource;
  readonly reference?: string | undefined;
  readonly lines: readonly JournalEntryInput["lines"][number][];
  /** The posting date used for a reversal. Defaults to the entry's own date. */
  readonly reversalDate?: string | undefined;
}

function lineSignature(lines: EntrySpec["lines"]): string {
  return lines
    .map((line) => {
      const debit = line.debitFils ?? 0;
      const credit = line.creditFils ?? 0;
      return `${line.accountCode}|${String(debit)}|${String(credit)}|${line.partyId ?? ""}|${
        line.documentId ?? ""
      }`;
    })
    .sort()
    .join(";");
}

/**
 * Post a business record's entry, or correct it if it has changed.
 *
 * Returns the entry that is now in force. When nothing needed to change, the
 * existing entry is returned untouched - which is what makes a retried save
 * free.
 */
export function syncEntry(context: PostContext, spec: EntrySpec): JournalEntryRecord | null {
  const { db } = context;

  if (spec.lines.length === 0) return null;

  const active = activeEntryForSource(db, spec.baseKey);

  if (active !== null) {
    const same =
      active.entryDate === spec.entryDate &&
      lineSignature(active.lines) === lineSignature(spec.lines);

    if (same) return active;

    // The record changed. The old posting is reversed rather than edited, and
    // the replacement is posted beside it.
    reverseEntry(
      context,
      active.id,
      "The source record was edited, so this posting was replaced",
      spec.reversalDate ?? spec.entryDate,
    );
  }

  return postEntry(context, {
    entryDate: spec.entryDate,
    description: spec.description,
    source: spec.source,
    reference: spec.reference,
    lines: spec.lines,
    sourceKey: nextSourceKey(db, spec.baseKey),
  });
}

/**
 * Reverse whatever is in force for a business record.
 *
 * Used when the record itself goes away - a cancelled invoice, a deleted
 * payment - so the ledger keeps no trace of money that never happened.
 */
export function reverseSource(
  context: PostContext,
  baseKey: string,
  reason: string,
  nowDate: string,
): void {
  const { db } = context;

  const active = activeEntryForSource(db, baseKey);
  if (active === null) return;

  reverseEntry(context, active.id, reason, nowDate);
}

/**
 * The balance of an account in the ledger, in fils.
 *
 * Re-exported here so callers that work with postings do not have to reach
 * into two modules for one figure.
 */
export function accountBalance(db: SqliteDatabase, code: string, toDate: string): Fils {
  const row = db
    .prepare(
      `SELECT a.normal_balance AS normalBalance,
              COALESCE(SUM(l.debit_fils), 0) AS debit,
              COALESCE(SUM(l.credit_fils), 0) AS credit
         FROM accounts a
         LEFT JOIN journal_lines l ON l.account_id = a.id
         LEFT JOIN journal_entries e ON e.id = l.entry_id
        WHERE a.code = ? AND (e.id IS NULL OR (e.status IN ('posted','reversed') AND e.entry_date <= ?))
        GROUP BY a.id`,
    )
    .get(code, toDate) as
    | { normalBalance: "debit" | "credit"; debit: number; credit: number }
    | undefined;

  if (row === undefined) return 0;
  const movement = row.debit - row.credit;
  return row.normalBalance === "debit" ? movement : -movement;
}
