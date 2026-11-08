/**
 * The double-entry engine.
 *
 * One rule governs everything here: a posted entry balances, and the only way to
 * change a posted entry is to post a reversing one. Nothing in this module ever
 * edits or deletes a posted entry, because a financial record that can be
 * silently rewritten is not a record.
 *
 * Safety is enforced in three places on purpose, not one:
 *
 *  1. `validateEntry` refuses unbalanced, empty, zero-sided and inactive-account
 *     entries before anything is written.
 *  2. The schema refuses a line that is neither a debit nor a credit, and an
 *     entry whose stored totals disagree with each other.
 *  3. `postEntry` re-checks the totals after the insert, so a bug in this module
 *     cannot leave a half-written entry behind.
 *
 * Idempotency is the `source_key`. An entry carries where it came from
 * ("sale:41"), which is UNIQUE, so a retried save collides instead of posting
 * twice. `postEntry` treats that collision as success and hands back the entry
 * that is already there.
 */

import type { SqliteDatabase } from "../../data/connection";
import { assertFils, sumFils, type Fils } from "../../domain/money";

export type JournalSource =
  | "purchase"
  | "sale"
  | "payment"
  | "expense"
  | "manual"
  | "transfer"
  | "opening"
  | "reversal"
  | "adjustment";

export type JournalStatus = "draft" | "posted" | "reversed";

export class AccountingError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AccountingError";
  }
}

/** One side of a journal line. Exactly one of the two amounts is non-zero. */
export interface JournalLine {
  /** Account code, e.g. "1000". Resolved to a row id at post time. */
  readonly accountCode: string;
  readonly debitFils?: Fils | undefined;
  readonly creditFils?: Fils | undefined;
  readonly description?: string | undefined;
  readonly partyId?: number | null | undefined;
  readonly documentId?: number | null | undefined;
}

export type JournalLineInput = JournalLine;

export interface JournalEntryInput {
  readonly entryDate: string;
  readonly description: string;
  readonly source: JournalSource;
  readonly lines: readonly JournalLine[];
  /**
   * Unique origin key, e.g. "sale:41". Posting twice with the same key is a
   * no-op that returns the first entry.
   */
  readonly sourceKey?: string | undefined;
  readonly reference?: string | undefined;
  readonly entryNo?: string | undefined;
  readonly createdBy?: string | undefined;
  readonly status?: JournalStatus;
  readonly reversesEntryId?: number | undefined;
}

export interface JournalEntryRecord {
  readonly id: number;
  readonly entryNo: string;
  readonly entryDate: string;
  readonly description: string;
  readonly source: JournalSource;
  readonly status: JournalStatus;
  readonly sourceKey: string | null;
  readonly totalDebitFils: Fils;
  readonly totalCreditFils: Fils;
  readonly lines: readonly {
    readonly accountCode: string;
    readonly debitFils: Fils;
    readonly creditFils: Fils;
    readonly partyId: number | null;
    readonly documentId: number | null;
  }[];
}

/* -------------------------------------------------------------------------- */
/* periods                                                                    */
/* -------------------------------------------------------------------------- */

/** Throw if `entryDate` falls in a closed period. */
export function assertPeriodOpen(db: SqliteDatabase, entryDate: string): void {
  const closed = db
    .prepare(
      `SELECT name FROM accounting_periods
        WHERE status = 'closed' AND ? BETWEEN start_date AND end_date`,
    )
    .get(entryDate) as { name: string } | undefined;

  if (closed !== undefined) {
    throw new AccountingError(
      `${closed.name} is closed. Post to an open period, or reopen it first.`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* numbering                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Next journal number for a day.
 *
 * Sequential per day (`JE-20260115-0001`), which is readable when printed and
 * still sortable. The UNIQUE constraint on `entry_no` is the real guarantee;
 * this is for humans.
 */
function nextEntryNo(db: SqliteDatabase, entryDate: string): string {
  const day = entryDate.replace(/-/g, "");
  const prefix = `JE-${day}-`;
  const last = db
    .prepare(
      "SELECT entry_no FROM journal_entries WHERE entry_no LIKE ? ORDER BY entry_no DESC LIMIT 1",
    )
    .get(`${prefix}%`) as { entry_no: string } | undefined;

  const next =
    last === undefined ? 1 : Number.parseInt(last.entry_no.slice(prefix.length), 10) + 1;
  return `${prefix}${String(next).padStart(4, "0")}`;
}

/* -------------------------------------------------------------------------- */
/* validation                                                                  */
/* -------------------------------------------------------------------------- */

export interface ValidatedEntry {
  readonly totalDebitFils: Fils;
  readonly totalCreditFils: Fils;
  readonly normalisedLines: readonly {
    readonly accountCode: string;
    readonly debitFils: Fils;
    readonly creditFils: Fils;
    readonly description: string | null;
    readonly partyId: number | null;
    readonly documentId: number | null;
  }[];
}

/**
 * Everything an entry must satisfy before it may be written.
 *
 * Returns the normalised lines so the caller posts exactly what was checked -
 * the amounts are converted from Fils once and reused, rather than recomputed
 * on the way into SQL.
 */
export function validateEntry(
  db: SqliteDatabase,
  input: JournalEntryInput,
): ValidatedEntry {
  if (input.lines.length < 2) {
    throw new AccountingError(
      "A journal entry needs at least two lines: one for what went out and one for what came in.",
    );
  }

  const accounts = new Map(
    (
      db
        .prepare("SELECT id, code, name, is_active FROM accounts")
        .all() as { id: number; code: string; name: string; is_active: number }[]
    ).map((row) => [row.code, row]),
  );

  const normalised = input.lines.map((line, index) => {
    const where = `Line ${String(index + 1)}`;

    const debitFils = line.debitFils ?? 0;
    const creditFils = line.creditFils ?? 0;
    assertFils(debitFils, `${where} debit`);
    assertFils(creditFils, `${where} credit`);

    if (debitFils < 0 || creditFils < 0) {
      throw new AccountingError(
        `${where}: amounts cannot be negative. Post the opposite side instead.`,
      );
    }
    if (debitFils > 0 && creditFils > 0) {
      throw new AccountingError(`${where}: a line is either a debit or a credit, never both.`);
    }
    if (debitFils === 0 && creditFils === 0) {
      throw new AccountingError(`${where}: a zero line has no effect. Remove it.`);
    }

    const account = accounts.get(line.accountCode);
    if (account === undefined) {
      throw new AccountingError(`${where}: account ${line.accountCode} is not in the chart.`);
    }
    if (account.is_active !== 1) {
      throw new AccountingError(
        `${where}: ${account.name} is deactivated and cannot be posted to.`,
      );
    }

    return {
      accountCode: line.accountCode,
      debitFils,
      creditFils,
      description: line.description ?? null,
      partyId: line.partyId ?? null,
      documentId: line.documentId ?? null,
    };
  });

  const totalDebitFils = sumFils(normalised.map((line) => line.debitFils));
  const totalCreditFils = sumFils(normalised.map((line) => line.creditFils));

  if (totalDebitFils !== totalCreditFils) {
    throw new AccountingError(
      `This entry does not balance: debits ${String(totalDebitFils)} against credits ${String(
        totalCreditFils,
      )}, a difference of ${String(totalDebitFils - totalCreditFils)} fils.`,
    );
  }
  if (totalDebitFils === 0) {
    throw new AccountingError("This entry has no value. There is nothing to post.");
  }

  return { totalDebitFils, totalCreditFils, normalisedLines: normalised };
}

/* -------------------------------------------------------------------------- */
/* posting                                                                     */
/* -------------------------------------------------------------------------- */

export interface PostContext {
  readonly db: SqliteDatabase;
  readonly nowIso: string;
  readonly createdBy?: string | undefined;
}

/**
 * Post an entry.
 *
 * Idempotent: when `input.sourceKey` has already been posted, the existing
 * entry is returned untouched and nothing is written. That is what makes a
 * retried save safe.
 */
export function postEntry(context: PostContext, input: JournalEntryInput): JournalEntryRecord {
  const { db } = context;

  if (input.status !== "draft") assertPeriodOpen(db, input.entryDate);

  // Idempotency first, before any validation work: a retry of an already-posted
  // entry is a success, not an error.
  if (input.sourceKey !== undefined) {
    const existing = db
      .prepare("SELECT id FROM journal_entries WHERE source_key = ?")
      .get(input.sourceKey) as { id: number } | undefined;
    if (existing !== undefined) return readEntry(db, existing.id);
  }

  const validated = validateEntry(db, input);
  const entryNo = input.entryNo ?? nextEntryNo(db, input.entryDate);

  return db.transaction((): JournalEntryRecord => {
    const info = db
      .prepare(
        `INSERT INTO journal_entries
           (entry_no, entry_date, reference, description, source, status, source_key,
            reverses_entry_id, total_debit_fils, total_credit_fils, created_by,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entryNo,
        input.entryDate,
        input.reference ?? null,
        input.description,
        input.source,
        input.status ?? "posted",
        input.sourceKey ?? null,
        input.reversesEntryId ?? null,
        validated.totalDebitFils,
        validated.totalCreditFils,
        input.createdBy ?? context.createdBy ?? null,
        context.nowIso,
        context.nowIso,
      );

    const entryId = Number(info.lastInsertRowid);

    const insertLine = db.prepare(
      `INSERT INTO journal_lines
         (entry_id, line_no, account_id, description, debit_fils, credit_fils, party_id, document_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    validated.normalisedLines.forEach((line, index) => {
      const account = db.prepare("SELECT id FROM accounts WHERE code = ?").get(line.accountCode) as {
        id: number;
      };
      insertLine.run(
        entryId,
        index + 1,
        account.id,
        line.description,
        line.debitFils,
        line.creditFils,
        line.partyId,
        line.documentId,
      );
    });

    // Re-read the stored totals. If this module ever wrote something that did
    // not match what was validated, fail here rather than returning a record
    // that lies.
    const totals = db
      .prepare(
        `SELECT COALESCE(SUM(debit_fils), 0) AS debit, COALESCE(SUM(credit_fils), 0) AS credit
           FROM journal_lines WHERE entry_id = ?`,
      )
      .get(entryId) as { debit: number; credit: number };

    if (totals.debit !== validated.totalDebitFils || totals.credit !== validated.totalCreditFils) {
      throw new AccountingError("The entry did not store the amounts that were validated.");
    }

    return readEntry(db, entryId);
  })();
}

/**
 * Reverse a posted entry by posting its mirror image.
 *
 * The original is never edited or deleted; it is marked `reversed` and linked
 * to the new entry, so the audit trail shows both.
 */
export function reverseEntry(
  context: PostContext,
  entryId: number,
  reason: string,
  nowDate: string,
): JournalEntryRecord {
  const { db } = context;

  const original = readEntry(db, entryId);
  if (original.status !== "posted") {
    throw new AccountingError(
      `Entry ${original.entryNo} is ${original.status} and cannot be reversed.`,
    );
  }

  const already = db
    .prepare("SELECT id FROM journal_entries WHERE reverses_entry_id = ?")
    .get(entryId) as { id: number } | undefined;
  if (already !== undefined) {
    throw new AccountingError(`Entry ${original.entryNo} has already been reversed.`);
  }

  const entryNo = nextEntryNo(db, nowDate);
  const createdBy = context.createdBy ?? null;

  const reversal = db.transaction((): JournalEntryRecord => {
    const info = db
      .prepare(
        `INSERT INTO journal_entries
           (entry_no, entry_date, reference, description, source, status,
            reverses_entry_id, total_debit_fils, total_credit_fils, created_by,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, 'reversal', 'posted', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entryNo,
        nowDate,
        original.entryNo,
        `Reversal of ${original.entryNo}: ${reason}`,
        entryId,
        original.totalCreditFils,
        original.totalDebitFils,
        createdBy,
        context.nowIso,
        context.nowIso,
      );

    const reversalId = Number(info.lastInsertRowid);

    const originalLines = db
      .prepare(
        `SELECT a.code AS code, l.debit_fils AS debit, l.credit_fils AS credit,
                l.description AS description, l.party_id AS partyId, l.document_id AS documentId
           FROM journal_lines l
           JOIN accounts a ON a.id = l.account_id
          WHERE l.entry_id = ?
          ORDER BY l.line_no`,
      )
      .all(entryId) as {
      code: string;
      debit: number;
      credit: number;
      description: string | null;
      partyId: number | null;
      documentId: number | null;
    }[];

    const insertLine = db.prepare(
      `INSERT INTO journal_lines
         (entry_id, line_no, account_id, description, debit_fils, credit_fils, party_id, document_id)
       VALUES (?, ?, (SELECT id FROM accounts WHERE code = ?), ?, ?, ?, ?, ?)`,
    );

    originalLines.forEach((line, index) => {
      // Swap the sides: what was debited is now credited and the reverse.
      insertLine.run(
        reversalId,
        index + 1,
        line.code,
        line.description,
        line.credit,
        line.debit,
        line.partyId,
        line.documentId,
      );
    });

    db.prepare(
      `UPDATE journal_entries
          SET status = 'reversed', reversed_by_entry_id = ?, updated_at = ?
        WHERE id = ?`,
    ).run(reversalId, context.nowIso, entryId);

    return readEntry(db, reversalId);
  })();

  return reversal;
}

/* -------------------------------------------------------------------------- */
/* reading                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The next source key for a business record.
 *
 * The first posting of a record uses the bare key ("sale:41"). If the record
 * is later edited, the old entry is reversed and the replacement is posted
 * under "sale:41:2", "sale:41:3" and so on.
 *
 * The suffix is what makes an edit safe: the key stays unique across every
 * revision of the same record, so no two entries can ever collide, and the
 * history of what was posted and then corrected is still visible in the
 * journal register.
 */
export function nextSourceKey(db: SqliteDatabase, baseKey: string): string {
  const rows = db
    .prepare(
      "SELECT source_key AS sourceKey FROM journal_entries WHERE source_key = ? OR source_key LIKE ?",
    )
    .all(baseKey, `${baseKey}:%`) as { sourceKey: string }[];

  let highest = 0;
  for (const row of rows) {
    if (row.sourceKey === baseKey) continue;
    const revision = Number.parseInt(row.sourceKey.slice(baseKey.length + 1), 10);
    if (Number.isFinite(revision) && revision > highest) highest = revision;
  }

  return highest === 0 ? baseKey : `${baseKey}:${String(highest + 1)}`;
}

/** The entry currently in force for a business record, if any. */
export function activeEntryForSource(
  db: SqliteDatabase,
  baseKey: string,
): JournalEntryRecord | null {
  const row = db
    .prepare(
      `SELECT id FROM journal_entries
        WHERE (source_key = ? OR source_key LIKE ?)
          AND status = 'posted'
        ORDER BY id DESC LIMIT 1`,
    )
    .get(baseKey, `${baseKey}:%`) as { id: number } | undefined;

  return row === undefined ? null : readEntry(db, row.id);
}

export interface JournalEntryListRow {
  readonly id: number;
  readonly entryNo: string;
  readonly entryDate: string;
  readonly reference: string | null;
  readonly description: string;
  readonly source: JournalSource;
  readonly status: JournalStatus;
  readonly totalDebitFils: Fils;
  readonly totalCreditFils: Fils;
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly reversesEntryId: number | null;
  readonly reversedByEntryId: number | null;
}

export interface JournalEntryListRequest {
  readonly fromDate?: string | undefined;
  readonly toDate?: string | undefined;
  readonly source?: JournalSource | undefined;
  readonly status?: JournalStatus | undefined;
  readonly search?: string | undefined;
  readonly accountCode?: string | undefined;
  readonly limit?: number | undefined;
}

/**
 * The journal register: every entry, newest first.
 *
 * Filtered in SQL rather than in JavaScript because a busy shop's journal is
 * the one table in this application that genuinely grows without bound, and a
 * register that loads the whole thing to show the last fifty rows is a
 * register that eventually stops opening.
 */
export function listJournalEntries(
  db: SqliteDatabase,
  request: JournalEntryListRequest,
): readonly JournalEntryListRow[] {
  const clauses: string[] = [];
  const params: (string | number)[] = [];

  if (request.fromDate !== undefined) {
    clauses.push("e.entry_date >= ?");
    params.push(request.fromDate);
  }
  if (request.toDate !== undefined) {
    clauses.push("e.entry_date <= ?");
    params.push(request.toDate);
  }
  if (request.source !== undefined) {
    clauses.push("e.source = ?");
    params.push(request.source);
  }
  if (request.status !== undefined) {
    clauses.push("e.status = ?");
    params.push(request.status);
  }
  if (request.accountCode !== undefined) {
    clauses.push(
      "EXISTS (SELECT 1 FROM journal_lines l JOIN accounts a ON a.id = l.account_id " +
        "WHERE l.entry_id = e.id AND a.code = ?)",
    );
    params.push(request.accountCode);
  }
  if (request.search !== undefined && request.search.length > 0) {
    clauses.push("(e.entry_no LIKE ? OR e.description LIKE ? OR IFNULL(e.reference,'') LIKE ?)");
    const like = `%${request.search}%`;
    params.push(like, like, like);
  }

  const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  const limit = request.limit ?? 500;

  const rows = db
    .prepare(
      `SELECT e.id, e.entry_no, e.entry_date, e.reference, e.description, e.source, e.status,
              e.total_debit_fils, e.total_credit_fils, e.created_by, e.created_at,
              e.reverses_entry_id, e.reversed_by_entry_id
         FROM journal_entries e${where}
        ORDER BY e.entry_date DESC, e.id DESC
        LIMIT ?`,
    )
    .all(...params, limit) as {
    id: number;
    entry_no: string;
    entry_date: string;
    reference: string | null;
    description: string;
    source: JournalSource;
    status: JournalStatus;
    total_debit_fils: number;
    total_credit_fils: number;
    created_by: string | null;
    created_at: string;
    reverses_entry_id: number | null;
    reversed_by_entry_id: number | null;
  }[];

  return rows.map((row) => ({
    id: row.id,
    entryNo: row.entry_no,
    entryDate: row.entry_date,
    reference: row.reference,
    description: row.description,
    source: row.source,
    status: row.status,
    totalDebitFils: row.total_debit_fils,
    totalCreditFils: row.total_credit_fils,
    createdBy: row.created_by,
    createdAt: row.created_at,
    reversesEntryId: row.reverses_entry_id,
    reversedByEntryId: row.reversed_by_entry_id,
  }));
}

export interface JournalLineDetail {
  readonly lineNo: number;
  readonly accountId: number;
  readonly accountCode: string;
  readonly accountName: string;
  readonly description: string | null;
  readonly debitFils: Fils;
  readonly creditFils: Fils;
  readonly partyId: number | null;
  readonly partyName: string | null;
  readonly documentId: number | null;
  readonly documentNumber: string | null;
}

export interface JournalEntryDetail extends JournalEntryListRow {
  readonly sourceKey: string | null;
  readonly lines: readonly JournalLineDetail[];
}

/** One entry with its lines, ready to print. */
export function readEntryDetail(db: SqliteDatabase, entryId: number): JournalEntryDetail {
  const row = db
    .prepare(
      `SELECT e.id, e.entry_no, e.entry_date, e.reference, e.description, e.source, e.status,
              e.total_debit_fils, e.total_credit_fils, e.created_by, e.created_at,
              e.reverses_entry_id, e.reversed_by_entry_id, e.source_key
         FROM journal_entries e WHERE e.id = ?`,
    )
    .get(entryId) as
    | {
        id: number;
        entry_no: string;
        entry_date: string;
        reference: string | null;
        description: string;
        source: JournalSource;
        status: JournalStatus;
        total_debit_fils: number;
        total_credit_fils: number;
        created_by: string | null;
        created_at: string;
        reverses_entry_id: number | null;
        reversed_by_entry_id: number | null;
        source_key: string | null;
      }
    | undefined;

  if (row === undefined) {
    throw new AccountingError(`Journal entry ${String(entryId)} was not found.`);
  }

  const lines = db
    .prepare(
      `SELECT l.line_no, l.account_id, a.code AS accountCode, a.name AS accountName,
              l.description, l.debit_fils, l.credit_fils, l.party_id, l.document_id,
              p.name AS partyName, d.number AS documentNumber
         FROM journal_lines l
         JOIN accounts a ON a.id = l.account_id
         LEFT JOIN parties p ON p.id = l.party_id
         LEFT JOIN documents d ON d.id = l.document_id
        WHERE l.entry_id = ?
        ORDER BY l.line_no`,
    )
    .all(entryId) as {
    line_no: number;
    account_id: number;
    accountCode: string;
    accountName: string;
    description: string | null;
    debit_fils: number;
    credit_fils: number;
    party_id: number | null;
    document_id: number | null;
    partyName: string | null;
    documentNumber: string | null;
  }[];

  return {
    id: row.id,
    entryNo: row.entry_no,
    entryDate: row.entry_date,
    reference: row.reference,
    description: row.description,
    source: row.source,
    status: row.status,
    totalDebitFils: row.total_debit_fils,
    totalCreditFils: row.total_credit_fils,
    createdBy: row.created_by,
    createdAt: row.created_at,
    reversesEntryId: row.reverses_entry_id,
    reversedByEntryId: row.reversed_by_entry_id,
    sourceKey: row.source_key,
    lines: lines.map((line) => ({
      lineNo: line.line_no,
      accountId: line.account_id,
      accountCode: line.accountCode,
      accountName: line.accountName,
      description: line.description,
      debitFils: line.debit_fils,
      creditFils: line.credit_fils,
      partyId: line.party_id,
      partyName: line.partyName,
      documentId: line.document_id,
      documentNumber: line.documentNumber,
    })),
  };
}

/* -------------------------------------------------------------------------- */
/* drafts                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Replace the lines of a draft entry.
 *
 * Only a draft may be edited. A posted entry is corrected by a reversal, so
 * there is no path here that can rewrite a posted financial record.
 */
export function updateDraft(
  context: PostContext,
  entryId: number,
  input: Omit<JournalEntryInput, "status" | "sourceKey">,
): JournalEntryRecord {
  const { db } = context;

  const existing = db
    .prepare("SELECT id, status FROM journal_entries WHERE id = ?")
    .get(entryId) as { id: number; status: JournalStatus } | undefined;
  if (existing === undefined) {
    throw new AccountingError(`Journal entry ${String(entryId)} was not found.`);
  }
  if (existing.status !== "draft") {
    throw new AccountingError(
      "Only a draft can be edited. Post a correcting entry instead of changing a posted one.",
    );
  }

  const validated = validateEntry(db, input);

  return db.transaction((): JournalEntryRecord => {
    db.prepare(
      `UPDATE journal_entries
          SET entry_date = ?, reference = ?, description = ?, total_debit_fils = ?,
              total_credit_fils = ?, updated_at = ?
        WHERE id = ?`,
    ).run(
      input.entryDate,
      input.reference ?? null,
      input.description,
      validated.totalDebitFils,
      validated.totalCreditFils,
      context.nowIso,
      entryId,
    );

    db.prepare("DELETE FROM journal_lines WHERE entry_id = ?").run(entryId);

    const insertLine = db.prepare(
      `INSERT INTO journal_lines
         (entry_id, line_no, account_id, description, debit_fils, credit_fils, party_id, document_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    validated.normalisedLines.forEach((line, index) => {
      const account = db.prepare("SELECT id FROM accounts WHERE code = ?").get(line.accountCode) as {
        id: number;
      };
      insertLine.run(
        entryId,
        index + 1,
        account.id,
        line.description,
        line.debitFils,
        line.creditFils,
        line.partyId,
        line.documentId,
      );
    });

    return readEntry(db, entryId);
  })();
}

/**
 * Turn a draft into a posted entry.
 *
 * The validation runs again at this moment rather than trusting the draft: an
 * account may have been deactivated, or the period closed, since the draft
 * was written.
 */
export function postDraft(context: PostContext, entryId: number): JournalEntryRecord {
  const { db } = context;

  const row = db
    .prepare(
      `SELECT entry_date, description, source, reference, created_by
         FROM journal_entries WHERE id = ?`,
    )
    .get(entryId) as
    | {
        entry_date: string;
        description: string;
        source: JournalSource;
        reference: string | null;
        created_by: string | null;
      }
    | undefined;
  if (row === undefined) {
    throw new AccountingError(`Journal entry ${String(entryId)} was not found.`);
  }

  const status = db.prepare("SELECT status FROM journal_entries WHERE id = ?").get(entryId) as {
    status: JournalStatus;
  };
  if (status.status !== "draft") {
    throw new AccountingError("That entry is already posted.");
  }

  const lines = db
    .prepare(
      `SELECT a.code AS code, l.debit_fils AS debit, l.credit_fils AS credit,
              l.description AS description, l.party_id AS partyId, l.document_id AS documentId
         FROM journal_lines l
         JOIN accounts a ON a.id = l.account_id
        WHERE l.entry_id = ?
        ORDER BY l.line_no`,
    )
    .all(entryId) as {
    code: string;
    debit: number;
    credit: number;
    description: string | null;
    partyId: number | null;
    documentId: number | null;
  }[];

  const validated = validateEntry(db, {
    entryDate: row.entry_date,
    description: row.description,
    source: row.source,
    lines: lines.map((line) => ({
      accountCode: line.code,
      debitFils: line.debit,
      creditFils: line.credit,
      description: line.description ?? undefined,
      partyId: line.partyId ?? undefined,
      documentId: line.documentId ?? undefined,
    })),
  });

  assertPeriodOpen(db, row.entry_date);

  db.prepare(
    `UPDATE journal_entries
        SET status = 'posted', total_debit_fils = ?, total_credit_fils = ?, updated_at = ?
      WHERE id = ?`,
  ).run(validated.totalDebitFils, validated.totalCreditFils, context.nowIso, entryId);

  return readEntry(db, entryId);
}

/** Discard a draft. A posted entry is never deleted - it is reversed. */
export function deleteDraft(context: PostContext, entryId: number): void {
  const { db } = context;

  const row = db.prepare("SELECT status FROM journal_entries WHERE id = ?").get(entryId) as
    | { status: JournalStatus }
    | undefined;
  if (row === undefined) {
    throw new AccountingError(`Journal entry ${String(entryId)} was not found.`);
  }
  if (row.status !== "draft") {
    throw new AccountingError(
      "A posted entry cannot be deleted. Reverse it instead, so the correction is on the record.",
    );
  }

  db.transaction(() => {
    db.prepare("DELETE FROM journal_lines WHERE entry_id = ?").run(entryId);
    db.prepare("DELETE FROM journal_entries WHERE id = ?").run(entryId);
  })();
}

export function readEntry(db: SqliteDatabase, entryId: number): JournalEntryRecord {
  const row = db
    .prepare(
      `SELECT id, entry_no, entry_date, description, source, status, source_key,
              total_debit_fils, total_credit_fils
         FROM journal_entries WHERE id = ?`,
    )
    .get(entryId) as
    | {
        id: number;
        entry_no: string;
        entry_date: string;
        description: string;
        source: JournalSource;
        status: JournalStatus;
        source_key: string | null;
        total_debit_fils: number;
        total_credit_fils: number;
      }
    | undefined;

  if (row === undefined) {
    throw new AccountingError(`Journal entry ${String(entryId)} was not found.`);
  }

  const lines = db
    .prepare(
      `SELECT a.code AS code, l.debit_fils AS debit, l.credit_fils AS credit,
              l.party_id AS partyId, l.document_id AS documentId
         FROM journal_lines l
         JOIN accounts a ON a.id = l.account_id
        WHERE l.entry_id = ?
        ORDER BY l.line_no`,
    )
    .all(entryId) as {
    code: string;
    debit: number;
    credit: number;
    partyId: number | null;
    documentId: number | null;
  }[];

  return {
    id: row.id,
    entryNo: row.entry_no,
    entryDate: row.entry_date,
    description: row.description,
    source: row.source,
    status: row.status,
    sourceKey: row.source_key,
    totalDebitFils: row.total_debit_fils,
    totalCreditFils: row.total_credit_fils,
    lines: lines.map((line) => ({
      accountCode: line.code,
      debitFils: line.debit,
      creditFils: line.credit,
      partyId: line.partyId,
      documentId: line.documentId,
    })),
  };
}

/** Total debits across every posted entry. Used by the trial balance check. */
export function postedTotals(db: SqliteDatabase): { debit: Fils; credit: Fils } {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(total_debit_fils), 0) AS debit,
              COALESCE(SUM(total_credit_fils), 0) AS credit
         FROM journal_entries WHERE status IN ('posted', 'reversed')`,
    )
    .get() as { debit: number; credit: number };
  return { debit: row.debit, credit: row.credit };
}
