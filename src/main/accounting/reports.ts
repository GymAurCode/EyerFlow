/**
 * The Finance read models.
 *
 * Every figure in this file is derived from posted journal entries. Nothing
 * reads `documents`, `payments` or `expenses` directly for a financial total,
 * so a report cannot disagree with the ledger: if the two ever did, it would
 * mean a posting was missed, and the reconciliation checks are what catch
 * that.
 *
 * The exception is the aging report, which is built from the invoice ledger
 * (`documents` with their allocations) because an aging report is about
 * *invoices* and their due dates, not about postings. The totals it produces
 * are cross-checked against the control account by `reconcile`.
 */

import type { SqliteDatabase } from "../../data/connection";
import { daysBetween, lastDayOfMonth, monthBounds } from "../../domain/dates";
import type { Fils } from "../../domain/money";
import { SYSTEM_ACCOUNTS } from "./chart";
import { accountBalanceAt, movements, reconcile } from "./ledger";

/* -------------------------------------------------------------------------- */
/* general ledger                                                              */
/* -------------------------------------------------------------------------- */

export interface GeneralLedgerRow {
  /** The journal line itself. Two lines of one entry are two rows. */
  readonly lineId: number;
  readonly entryId: number;
  readonly entryNo: string;
  readonly entryDate: string;
  readonly reference: string | null;
  readonly description: string | null;
  readonly source: string;
  /**
   * Whether the entry is posted or has been reversed.
   *
   * Both are in the ledger: a reversed entry is still part of the history and
   * the reversal beside it is what cancels it. Reading which is which is what
   * makes a correction legible instead of mysterious.
   */
  readonly status: "draft" | "posted" | "reversed";
  readonly debitFils: Fils;
  readonly creditFils: Fils;
  /** The balance after this line, in the account's own normal balance. */
  readonly runningBalanceFils: Fils;
  readonly documentId: number | null;
  readonly documentNumber: string | null;
  readonly partyName: string | null;
}

export interface GeneralLedger {
  readonly code: string;
  readonly name: string;
  readonly type: string;
  readonly normalBalance: "debit" | "credit";
  readonly fromDate: string;
  readonly toDate: string;
  readonly openingBalanceFils: Fils;
  readonly rows: readonly GeneralLedgerRow[];
  readonly totalDebitFils: Fils;
  readonly totalCreditFils: Fils;
  readonly closingBalanceFils: Fils;
}

/**
 * One account's ledger for a period.
 *
 * The opening balance is everything posted before the period, and the running
 * balance is carried line by line, so a reader can follow the money from one
 * line to the next rather than trusting a single closing figure.
 */
export function generalLedger(
  db: SqliteDatabase,
  code: string,
  fromDate: string,
  toDate: string,
): GeneralLedger {
  const account = db
    .prepare("SELECT id, code, name, type, normal_balance AS normalBalance FROM accounts WHERE code = ?")
    .get(code) as
    | { id: number; code: string; name: string; type: string; normalBalance: "debit" | "credit" }
    | undefined;

  if (account === undefined) {
    throw new Error(`Account ${code} is not in the Chart of Accounts.`);
  }

  const openingRows = db
    .prepare(
      `SELECT COALESCE(SUM(l.debit_fils), 0) AS debit, COALESCE(SUM(l.credit_fils), 0) AS credit
         FROM journal_lines l
         JOIN journal_entries e ON e.id = l.entry_id
        WHERE l.account_id = ? AND e.status IN ('posted','reversed') AND e.entry_date < ?`,
    )
    .get(account.id, fromDate) as { debit: number; credit: number };

  const movement = openingRows.debit - openingRows.credit;
  const openingBalanceFils =
    account.normalBalance === "debit" ? movement : -movement;

  const lines = db
    .prepare(
      `SELECT l.id AS lineId, l.entry_id AS entryId, e.entry_no AS entryNo, e.entry_date AS entryDate,
              e.reference AS reference, e.description AS description, e.source AS source,
              e.status AS status,
              l.debit_fils AS debit, l.credit_fils AS credit,
              l.document_id AS documentId, d.number AS documentNumber, p.name AS partyName
         FROM journal_lines l
         JOIN journal_entries e ON e.id = l.entry_id
         LEFT JOIN documents d ON d.id = l.document_id
         LEFT JOIN parties p ON p.id = l.party_id
        WHERE l.account_id = ? AND e.status IN ('posted','reversed')
          AND e.entry_date BETWEEN ? AND ?
        ORDER BY e.entry_date, e.id, l.line_no`,
    )
    .all(account.id, fromDate, toDate) as {
    lineId: number;
    entryId: number;
    entryNo: string;
    entryDate: string;
    reference: string | null;
    description: string | null;
    source: string;
    status: "draft" | "posted" | "reversed";
    debit: number;
    credit: number;
    documentId: number | null;
    documentNumber: string | null;
    partyName: string | null;
  }[];

  let running = openingBalanceFils;
  const rows: GeneralLedgerRow[] = lines.map((line) => {
    const delta = line.debit - line.credit;
    running = account.normalBalance === "debit" ? running + delta : running - delta;
    return {
      lineId: line.lineId,
      entryId: line.entryId,
      entryNo: line.entryNo,
      entryDate: line.entryDate,
      reference: line.reference,
      description: line.description,
      source: line.source,
      status: line.status,
      debitFils: line.debit,
      creditFils: line.credit,
      runningBalanceFils: running,
      documentId: line.documentId,
      documentNumber: line.documentNumber,
      partyName: line.partyName,
    };
  });

  const totalDebitFils = rows.reduce((sum, row) => sum + row.debitFils, 0);
  const totalCreditFils = rows.reduce((sum, row) => sum + row.creditFils, 0);

  return {
    code: account.code,
    name: account.name,
    type: account.type,
    normalBalance: account.normalBalance,
    fromDate,
    toDate,
    openingBalanceFils,
    rows,
    totalDebitFils,
    totalCreditFils,
    closingBalanceFils: running,
  };
}

/* -------------------------------------------------------------------------- */
/* party statement                                                             */
/* -------------------------------------------------------------------------- */

export type PartyLedgerKind = "customer" | "supplier";

export interface PartyLedgerRow {
  readonly entryId: number;
  readonly entryNo: string;
  readonly entryDate: string;
  readonly reference: string | null;
  readonly documentNumber: string | null;
  /** What the line was: an invoice, a receipt, a payment, a correction. */
  readonly kind: "invoice" | "receipt" | "payment" | "adjustment";
  readonly description: string;
  /** Increases the party's balance. */
  readonly debitFils: Fils;
  /** Reduces the party's balance. */
  readonly creditFils: Fils;
  readonly runningBalanceFils: Fils;
  /** Whether the originating invoice is settled. */
  readonly isSettled: boolean | null;
  readonly dueDate: string | null;
  readonly documentId: number | null;
}

export interface PartyStatement {
  readonly partyId: number;
  readonly partyName: string;
  readonly kind: PartyLedgerKind;
  readonly fromDate: string;
  readonly toDate: string;
  readonly openingBalanceFils: Fils;
  readonly rows: readonly PartyLedgerRow[];
  readonly totalDebitFils: Fils;
  readonly totalCreditFils: Fils;
  readonly closingBalanceFils: Fils;
  readonly overdueFils: Fils;
}

const PARTY_CONTROL: Record<PartyLedgerKind, string> = {
  customer: SYSTEM_ACCOUNTS.accountsReceivable,
  supplier: SYSTEM_ACCOUNTS.accountsPayable,
};

/**
 * A customer or supplier statement, straight from the subledger.
 *
 * The lines are the ones that name the party on the control account, so the
 * closing balance is by construction the same number the control account
 * holds for that party. An invoice is a debit (it increases what the customer
 * owes); a receipt is a credit (it reduces it).
 */
export function partyStatement(
  db: SqliteDatabase,
  partyId: number,
  kind: PartyLedgerKind,
  fromDate: string,
  toDate: string,
): PartyStatement {
  const control = PARTY_CONTROL[kind];

  const party = db.prepare("SELECT id, name, kind FROM parties WHERE id = ?").get(partyId) as
    | { id: number; name: string; kind: string }
    | undefined;
  if (party === undefined) throw new Error("That customer or supplier was not found.");

  const opening = db
    .prepare(
      `SELECT COALESCE(SUM(l.debit_fils), 0) AS debit, COALESCE(SUM(l.credit_fils), 0) AS credit
         FROM journal_lines l
         JOIN journal_entries e ON e.id = l.entry_id
         JOIN accounts a ON a.id = l.account_id
        WHERE l.party_id = ? AND a.code = ?
          AND e.status IN ('posted','reversed') AND e.entry_date < ?`,
    )
    .get(partyId, control, fromDate) as { debit: number; credit: number };

  // A receivable is a debit balance; a payable is a credit balance. The
  // statement is written the same way round for both so the column headings
  // never have to be explained.
  const openingBalanceFils =
    kind === "customer" ? opening.debit - opening.credit : opening.credit - opening.debit;

  const lines = db
    .prepare(
      `SELECT l.entry_id AS entryId, e.entry_no AS entryNo, e.entry_date AS entryDate,
              e.reference AS reference, e.source AS source, e.description AS entryDescription,
              l.debit_fils AS debit, l.credit_fils AS credit,
              l.document_id AS documentId, d.number AS documentNumber, d.due_date AS dueDate,
              d.status AS documentStatus, d.gross_fils AS documentGross, d.paid_fils AS documentPaid
         FROM journal_lines l
         JOIN journal_entries e ON e.id = l.entry_id
         JOIN accounts a ON a.id = l.account_id
         LEFT JOIN documents d ON d.id = l.document_id
        WHERE l.party_id = ? AND a.code = ?
          AND e.status IN ('posted','reversed') AND e.entry_date BETWEEN ? AND ?
        ORDER BY e.entry_date, e.id, l.line_no`,
    )
    .all(partyId, control, fromDate, toDate) as {
    entryId: number;
    entryNo: string;
    entryDate: string;
    reference: string | null;
    source: string;
    entryDescription: string;
    debit: number;
    credit: number;
    documentId: number | null;
    documentNumber: string | null;
    dueDate: string | null;
    documentStatus: string | null;
    documentGross: number | null;
    documentPaid: number | null;
  }[];

  let running = openingBalanceFils;
  const rows: PartyLedgerRow[] = lines.map((line) => {
    const debit = kind === "customer" ? line.debit : line.credit;
    const credit = kind === "customer" ? line.credit : line.debit;
    running += debit - credit;

    const isInvoice = line.source === "sale" || line.source === "purchase";
    const isSettled =
      line.documentGross === null || line.documentPaid === null
        ? null
        : line.documentPaid >= line.documentGross;

    return {
      entryId: line.entryId,
      entryNo: line.entryNo,
      entryDate: line.entryDate,
      reference: line.reference,
      documentNumber: line.documentNumber,
      kind: isInvoice ? "invoice" : line.source === "payment" ? (kind === "customer" ? "receipt" : "payment") : "adjustment",
      description:
        line.documentNumber !== null
          ? `${line.documentNumber}${line.entryDescription.length > 0 ? ` — ${line.entryDescription}` : ""}`
          : line.entryDescription,
      debitFils: debit,
      creditFils: credit,
      runningBalanceFils: running,
      isSettled,
      dueDate: line.dueDate,
      documentId: line.documentId,
    };
  });

  const totalDebitFils = rows.reduce((sum, row) => sum + row.debitFils, 0);
  const totalCreditFils = rows.reduce((sum, row) => sum + row.creditFils, 0);

  // Overdue: money owed on an invoice whose due date has passed.
  const asOf = toDate;
  const overdue = rows
    .filter((row) => {
      if (row.kind !== "invoice" || row.isSettled !== false) return false;
      if (row.dueDate === null) return false;
      return daysBetween(row.dueDate, asOf) > 0;
    })
    .reduce((sum, row) => sum + row.debitFils, 0);

  return {
    partyId,
    partyName: party.name,
    kind,
    fromDate,
    toDate,
    openingBalanceFils,
    rows,
    totalDebitFils,
    totalCreditFils,
    closingBalanceFils: running,
    overdueFils: overdue,
  };
}

/* -------------------------------------------------------------------------- */
/* aging                                                                       */
/* -------------------------------------------------------------------------- */

export type AgingBucket = "notDue" | "d1_30" | "d31_60" | "d61_90" | "d90plus";

export const AGING_BUCKETS: readonly { readonly key: AgingBucket; readonly label: string }[] = [
  { key: "notDue", label: "Not yet due" },
  { key: "d1_30", label: "1–30 days overdue" },
  { key: "d31_60", label: "31–60 days overdue" },
  { key: "d61_90", label: "61–90 days overdue" },
  { key: "d90plus", label: "Over 90 days overdue" },
];

export interface AgingRow {
  readonly documentId: number;
  readonly documentNumber: string;
  readonly partyId: number;
  readonly partyName: string;
  readonly issueDate: string;
  readonly dueDate: string | null;
  readonly totalFils: Fils;
  readonly paidFils: Fils;
  readonly outstandingFils: Fils;
  readonly daysOverdue: number;
  readonly bucket: AgingBucket;
}

export interface AgingSummary {
  readonly asOfDate: string;
  readonly rows: readonly AgingRow[];
  readonly totals: readonly { readonly bucket: AgingBucket; readonly label: string; readonly amountFils: Fils }[];
  readonly totalOutstandingFils: Fils;
  readonly totalOverdueFils: Fils;
  readonly side: "receivable" | "payable";
}

/**
 * Outstanding invoices, bucketed by how late they are.
 *
 * An invoice with no due date is treated as not yet due rather than as
 * overdue: an invoice without a date is an omission, not a debt that has
 * been ignored, and guessing otherwise would overstate how much is late.
 */
export function agingReport(
  db: SqliteDatabase,
  asOfDate: string,
  side: "receivable" | "payable",
): AgingSummary {
  const kind = side === "receivable" ? "invoice" : "purchaseInvoice";

  const rows = db
    .prepare(
      `SELECT d.id, d.number, d.party_id, d.issue_date, d.due_date,
              d.gross_fils, d.paid_fils, COALESCE(p.name, '') AS party_name
         FROM documents d
         LEFT JOIN parties p ON p.id = d.party_id
        WHERE d.kind = ? AND d.status IN ('issued','partPaid') AND d.gross_fils > d.paid_fils
        ORDER BY d.issue_date, d.number`,
    )
    .all(kind) as {
    id: number;
    number: string;
    party_id: number | null;
    issue_date: string;
    due_date: string | null;
    gross_fils: number;
    paid_fils: number;
    party_name: string;
  }[];

  const mapped: AgingRow[] = rows.map((row) => {
    const outstanding = row.gross_fils - row.paid_fils;
    const dueDate = row.due_date;
    const daysOverdue = dueDate === null ? 0 : daysBetween(dueDate, asOfDate);

    let bucket: AgingBucket = "notDue";
    if (dueDate !== null && daysOverdue > 0) {
      if (daysOverdue <= 30) bucket = "d1_30";
      else if (daysOverdue <= 60) bucket = "d31_60";
      else if (daysOverdue <= 90) bucket = "d61_90";
      else bucket = "d90plus";
    }

    return {
      documentId: row.id,
      documentNumber: row.number,
      partyId: row.party_id ?? 0,
      partyName: row.party_name,
      issueDate: row.issue_date,
      dueDate,
      totalFils: row.gross_fils,
      paidFils: row.paid_fils,
      outstandingFils: outstanding,
      daysOverdue,
      bucket,
    };
  });

  const totals = AGING_BUCKETS.map((bucket) => ({
    bucket: bucket.key,
    label: bucket.label,
    amountFils: mapped
      .filter((row) => row.bucket === bucket.key)
      .reduce((sum, row) => sum + row.outstandingFils, 0),
  }));

  const totalOutstandingFils = mapped.reduce((sum, row) => sum + row.outstandingFils, 0);
  const totalOverdueFils = mapped
    .filter((row) => row.bucket !== "notDue")
    .reduce((sum, row) => sum + row.outstandingFils, 0);

  return {
    asOfDate,
    rows: mapped,
    totals,
    totalOutstandingFils,
    totalOverdueFils,
    side,
  };
}

/* -------------------------------------------------------------------------- */
/* cash flow                                                                   */
/* -------------------------------------------------------------------------- */

export interface CashFlowSection {
  readonly heading: string;
  readonly rows: readonly { readonly label: string; readonly amountFils: Fils }[];
  readonly totalFils: Fils;
}

export interface CashFlowStatement {
  readonly fromDate: string;
  readonly toDate: string;
  readonly openingCashFils: Fils;
  readonly operating: CashFlowSection;
  readonly investing: CashFlowSection;
  readonly financing: CashFlowSection;
  readonly netMovementFils: Fils;
  readonly closingCashFils: Fils;
  readonly totalReceivedFils: Fils;
  readonly totalPaidFils: Fils;
}

const CASH_CODES: readonly string[] = [SYSTEM_ACCOUNTS.cashInHand, SYSTEM_ACCOUNTS.bank];

/**
 * Cash received, cash paid, and where the money went.
 *
 * The statement is built from the cash and bank ledgers, and every movement
 * is classified by the account it moved against. That is what separates a
 * credit sale (no cash moved) from a cash sale (cash moved), which is the
 * distinction the whole statement exists to draw.
 */
export function cashFlowStatement(
  db: SqliteDatabase,
  fromDate: string,
  toDate: string,
): CashFlowStatement {
  const openingCashFils =
    accountBalanceAt(db, SYSTEM_ACCOUNTS.cashInHand, fromDate) +
    accountBalanceAt(db, SYSTEM_ACCOUNTS.bank, fromDate);

  const rows = db
    .prepare(
      `SELECT e.id AS entryId, e.entry_date AS entryDate, e.description AS description,
              l.debit_fils AS debit, l.credit_fils AS credit, a.code AS accountCode,
              a.type AS accountType, a.subtype AS accountSubtype
         FROM journal_lines l
         JOIN journal_entries e ON e.id = l.entry_id
         JOIN accounts a ON a.id = l.account_id
        WHERE a.code IN (?, ?)
          AND e.status IN ('posted','reversed')
          AND e.source <> 'opening'
          AND e.entry_date BETWEEN ? AND ?
        ORDER BY e.entry_date, e.id, l.line_no`,
    )
    .all(CASH_CODES[0], CASH_CODES[1], fromDate, toDate) as {
    entryId: number;
    entryDate: string;
    description: string;
    debit: number;
    credit: number;
    accountCode: string;
    accountType: string;
    accountSubtype: string | null;
  }[];

  // For each entry, the accounts on the other side of the cash movement.
  const counterparties = new Map<number, { readonly type: string; readonly subtype: string | null }[]>();
  const entryMeta = new Map<number, { readonly date: string; readonly description: string }>();

  const allLines = db
    .prepare(
      `SELECT l.entry_id AS entryId, a.code AS accountCode, a.type AS accountType,
              a.subtype AS accountSubtype, l.debit_fils AS debit, l.credit_fils AS credit
         FROM journal_lines l
         JOIN journal_entries e ON e.id = l.entry_id
         JOIN accounts a ON a.id = l.account_id
        WHERE e.status IN ('posted','reversed') AND e.source <> 'opening'
          AND e.entry_date BETWEEN ? AND ?`,
    )
    .all(fromDate, toDate) as {
    entryId: number;
    accountCode: string;
    accountType: string;
    accountSubtype: string | null;
    debit: number;
    credit: number;
  }[];

  for (const line of allLines) {
    if (CASH_CODES.includes(line.accountCode)) continue;
    const list = counterparties.get(line.entryId) ?? [];
    list.push({ type: line.accountType, subtype: line.accountSubtype });
    counterparties.set(line.entryId, list);
  }

  for (const row of rows) {
    entryMeta.set(row.entryId, { date: row.entryDate, description: row.description });
  }

  const buckets: Record<string, Map<string, Fils>> = {
    operating: new Map(),
    investing: new Map(),
    financing: new Map(),
  };

  let totalReceivedFils = 0;
  let totalPaidFils = 0;

  for (const row of rows) {
    const received = row.debit;
    const paid = row.credit;
    totalReceivedFils += received;
    totalPaidFils += paid;

    const net = received - paid;
    if (net === 0) continue;

    const others = counterparties.get(row.entryId) ?? [];
    const section = classifyCashMovement(others);

    const label = describeCashMovement(others, row.description);
    const map = buckets[section];
    if (map === undefined) continue;
    map.set(label, (map.get(label) ?? 0) + net);
  }

  const operating = toSection("Operating activities", buckets["operating"] as Map<string, Fils>);
  const investing = toSection("Investing activities", buckets["investing"] as Map<string, Fils>);
  const financing = toSection("Financing activities", buckets["financing"] as Map<string, Fils>);

  // The closing balance is read from the ledger rather than derived, so it is
  // the amount of money the business actually has - and an opening balance
  // posted inside the period cannot make the two disagree.
  const closingCashFils =
    accountBalanceAt(db, SYSTEM_ACCOUNTS.cashInHand, toDate) +
    accountBalanceAt(db, SYSTEM_ACCOUNTS.bank, toDate);

  const netMovementFils = closingCashFils - openingCashFils;

  return {
    fromDate,
    toDate,
    openingCashFils,
    operating,
    investing,
    financing,
    netMovementFils,
    closingCashFils,
    totalReceivedFils,
    totalPaidFils,
  };
}

function classifyCashMovement(
  others: readonly { readonly type: string; readonly subtype: string | null }[],
): "operating" | "investing" | "financing" {
  if (others.some((o) => o.type === "equity")) return "financing";
  if (others.some((o) => o.type === "liability" && o.subtype === "longTermLiability")) {
    return "financing";
  }
  if (others.some((o) => o.subtype === "fixedAsset" || o.subtype === "contraAsset")) {
    return "investing";
  }
  return "operating";
}

function describeCashMovement(
  others: readonly { readonly type: string; readonly subtype: string | null }[],
  fallback: string,
): string {
  if (others.length === 0) return fallback;
  if (others.some((o) => o.type === "equity")) return "Capital and drawings";
  if (others.some((o) => o.type === "liability" && o.subtype === "longTermLiability")) {
    return "Loan movements";
  }
  if (others.some((o) => o.subtype === "fixedAsset")) return "Fixed assets";
  if (others.some((o) => o.subtype === "contraAsset")) return "Fixed asset depreciation";
  if (others.some((o) => o.type === "income")) return "Receipts from sales and income";
  if (others.some((o) => o.type === "expense")) return "Payments for goods and expenses";
  if (others.some((o) => o.type === "asset")) return "Stock and other assets";
  return "Settlement of balances";
}

function toSection(heading: string, map: Map<string, Fils>): CashFlowSection {
  const rows = [...map.entries()]
    .filter(([, amount]) => amount !== 0)
    .map(([label, amount]) => ({ label, amountFils: amount }))
    .sort((a, b) => Math.abs(b.amountFils) - Math.abs(a.amountFils));

  return {
    heading,
    rows,
    totalFils: rows.reduce((sum, row) => sum + row.amountFils, 0),
  };
}

/* -------------------------------------------------------------------------- */
/* time series                                                                 */
/* -------------------------------------------------------------------------- */

export type SeriesGranularity = "day" | "week" | "month" | "quarter" | "year";

/** The SQL expression that buckets a date into a series key. */
function bucketExpression(granularity: SeriesGranularity): string {
  switch (granularity) {
    case "day":
      return "substr(e.entry_date, 1, 10)";
    case "week":
      return "strftime('%Y-%W', e.entry_date)";
    case "month":
      return "substr(e.entry_date, 1, 7)";
    case "quarter":
      return "substr(e.entry_date, 1, 4) || '-Q' || CAST((CAST(substr(e.entry_date, 6, 2) AS INTEGER) + 2) / 3 AS INTEGER)";
    case "year":
      return "substr(e.entry_date, 1, 4)";
  }
}

export interface SeriesPoint {
  readonly key: string;
  readonly label: string;
  readonly revenueFils: Fils;
  readonly expenseFils: Fils;
  readonly costFils: Fils;
  readonly grossProfitFils: Fils;
  readonly netProfitFils: Fils;
  readonly receivedFils: Fils;
  readonly paidFils: Fils;
}

/**
 * A monthly (or weekly, or yearly) series of the trading figures.
 *
 * The buckets are built in SQL and the labels in JavaScript, because SQLite
 * can group by a week but cannot spell one the way a person would.
 */
export function tradingSeries(
  db: SqliteDatabase,
  fromDate: string,
  toDate: string,
  granularity: SeriesGranularity,
): readonly SeriesPoint[] {
  const bucket = bucketExpression(granularity);

  const rows = db
    .prepare(
      `SELECT ${bucket} AS bucket,
              SUM(CASE WHEN a.code = ? THEN l.credit_fils - l.debit_fils ELSE 0 END) AS revenue,
              SUM(CASE WHEN a.code = ? THEN l.debit_fils - l.credit_fils ELSE 0 END) AS cogs,
              SUM(CASE WHEN a.type = 'expense' AND a.code <> ? THEN l.debit_fils - l.credit_fils ELSE 0 END) AS expenses,
              SUM(CASE WHEN a.type = 'income' AND a.code <> ? THEN l.credit_fils - l.debit_fils ELSE 0 END) AS otherIncome,
              SUM(CASE WHEN a.code IN (?, ?) THEN l.debit_fils ELSE 0 END) AS received,
              SUM(CASE WHEN a.code IN (?, ?) THEN l.credit_fils ELSE 0 END) AS paid
         FROM journal_lines l
         JOIN journal_entries e ON e.id = l.entry_id
         JOIN accounts a ON a.id = l.account_id
        WHERE e.status IN ('posted','reversed') AND e.entry_date BETWEEN ? AND ?
          AND e.source <> 'transfer'
        GROUP BY bucket
        ORDER BY bucket`,
    )
    .all(
      SYSTEM_ACCOUNTS.salesRevenue,
      SYSTEM_ACCOUNTS.costOfGoodsSold,
      SYSTEM_ACCOUNTS.costOfGoodsSold,
      SYSTEM_ACCOUNTS.salesRevenue,
      CASH_CODES[0],
      CASH_CODES[1],
      CASH_CODES[0],
      CASH_CODES[1],
      fromDate,
      toDate,
    ) as {
    bucket: string;
    revenue: number;
    cogs: number;
    expenses: number;
    otherIncome: number;
    received: number;
    paid: number;
  }[];

  return rows.map((row) => {
    const revenueFils = row.revenue;
    const expenseFils = row.expenses;
    const costFils = row.cogs;
    const grossProfitFils = revenueFils - costFils;
    const netProfitFils = grossProfitFils - expenseFils + row.otherIncome;
    return {
      key: row.bucket,
      label: seriesLabel(row.bucket, granularity),
      revenueFils,
      expenseFils,
      costFils,
      grossProfitFils,
      netProfitFils,
      receivedFils: row.received,
      paidFils: row.paid,
    };
  });
}

/** A label a person would read for a series key. */
export function seriesLabel(key: string, granularity: SeriesGranularity): string {
  switch (granularity) {
    case "day": {
      const [year, month, day] = key.split("-");
      return `${day ?? ""}/${month ?? ""}/${String(year ?? "").slice(2)}`;
    }
    case "week": {
      const [year, week] = key.split("-");
      return `W${week ?? ""} ${String(year ?? "").slice(2)}`;
    }
    case "month": {
      const [year, month] = key.split("-");
      const index = Number.parseInt(month ?? "1", 10) - 1;
      const names = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun",
        "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
      ];
      return `${names[index] ?? month ?? ""} ${String(year ?? "").slice(2)}`;
    }
    case "quarter": {
      const [year, quarter] = key.split("-");
      return `${quarter ?? ""} ${String(year ?? "").slice(2)}`;
    }
    case "year":
      return key;
  }
}

/* -------------------------------------------------------------------------- */
/* finance dashboard                                                           */
/* -------------------------------------------------------------------------- */

export interface FinanceMetric {
  readonly key: string;
  readonly label: string;
  readonly hint: string;
  readonly amountFils: Fils;
  /** Change against the previous period, as a fraction. Null when unknown. */
  readonly delta: number | null;
  /** Whether the account is a balance at a point in time or a period total. */
  readonly kind: "balance" | "period";
}

export interface FinanceOverview {
  readonly asOfDate: string;
  readonly fromDate: string;
  readonly toDate: string;
  readonly previousFromDate: string;
  readonly previousToDate: string;
  readonly metrics: readonly FinanceMetric[];
  readonly reconciliation: ReturnType<typeof reconcile>;
  readonly expenseBreakdown: readonly { readonly code: string; readonly name: string; readonly amountFils: Fils }[];
  readonly series: readonly SeriesPoint[];
  readonly cashFlow: CashFlowStatement;
  readonly receivableAging: AgingSummary;
  readonly payableAging: AgingSummary;
  readonly inventoryValueFils: Fils;
}

/**
 * The finance dashboard.
 *
 * Balances and period totals are kept apart on purpose. Cash, receivables and
 * payables are what the shop holds *now*; revenue, expenses and profit are
 * what happened *over* the chosen period. Mixing them is how a dashboard ends
 * up claiming the business is richer than it is.
 */
export function financeOverview(
  db: SqliteDatabase,
  fromDate: string,
  toDate: string,
  asOfDate: string,
  previousFromDate: string,
  previousToDate: string,
  granularity: SeriesGranularity = "month",
): FinanceOverview {
  const balance = (code: string): Fils => accountBalanceAt(db, code, asOfDate);

  const period = new Map(
    movements(db, fromDate, toDate).map((row) => [row.code, row.balanceFils] as const),
  );
  const previous = new Map(
    movements(db, previousFromDate, previousToDate).map(
      (row) => [row.code, row.balanceFils] as const,
    ),
  );

  const periodAmount = (code: string): Fils => period.get(code) ?? 0;
  const previousAmount = (code: string): Fils => previous.get(code) ?? 0;

  const revenueFils = periodAmount(SYSTEM_ACCOUNTS.salesRevenue);
  const salesReturnsFils = periodAmount(SYSTEM_ACCOUNTS.salesReturns);
  const netSalesFils = revenueFils - salesReturnsFils;
  const costFils = periodAmount(SYSTEM_ACCOUNTS.costOfGoodsSold);

  const expenseAccounts = db
    .prepare(
      `SELECT code, name FROM accounts
        WHERE type = 'expense' AND code <> ? AND is_active = 1
        ORDER BY code`,
    )
    .all(SYSTEM_ACCOUNTS.costOfGoodsSold) as { code: string; name: string }[];

  const operatingExpensesFils = expenseAccounts.reduce(
    (sum, row) => sum + periodAmount(row.code),
    0,
  );

  const otherIncomeAccounts = db
    .prepare(
      `SELECT code, name FROM accounts
        WHERE type = 'income' AND code NOT IN (?, ?) AND is_active = 1
        ORDER BY code`,
    )
    .all(SYSTEM_ACCOUNTS.salesRevenue, SYSTEM_ACCOUNTS.salesReturns) as {
    code: string;
    name: string;
  }[];

  const otherIncomeFils = otherIncomeAccounts.reduce(
    (sum, row) => sum + periodAmount(row.code),
    0,
  );

  const grossProfitFils = netSalesFils - costFils;
  const netProfitFils = grossProfitFils - operatingExpensesFils + otherIncomeFils;

  const previousRevenueFils = previousAmount(SYSTEM_ACCOUNTS.salesRevenue);
  const previousNetSalesFils =
    previousRevenueFils - previousAmount(SYSTEM_ACCOUNTS.salesReturns);
  const previousCostFils = previousAmount(SYSTEM_ACCOUNTS.costOfGoodsSold);
  const previousOperatingExpensesFils = expenseAccounts.reduce(
    (sum, row) => sum + previousAmount(row.code),
    0,
  );
  const previousOtherIncomeFils = otherIncomeAccounts.reduce(
    (sum, row) => sum + previousAmount(row.code),
    0,
  );
  const previousGrossProfitFils = previousNetSalesFils - previousCostFils;
  const previousNetProfitFils =
    previousGrossProfitFils - previousOperatingExpensesFils + previousOtherIncomeFils;

  const cashFils = balance(SYSTEM_ACCOUNTS.cashInHand);
  const bankFils = balance(SYSTEM_ACCOUNTS.bank);
  const cashAndBankFils = cashFils + bankFils;
  const receivableFils = balance(SYSTEM_ACCOUNTS.accountsReceivable);
  const payableFils = balance(SYSTEM_ACCOUNTS.accountsPayable);
  const inventoryFils = balance(SYSTEM_ACCOUNTS.inventory);

  // Six figures, and no more. Cash, what is owed to the shop and what the
  // shop owes are balances as at today; revenue, expenses and profit are what
  // happened over the chosen period. Everything else the dashboard used to
  // show - a separate cash and bank figure, gross profit, the stock value,
  // working capital - was either a duplicate of one of these or a number the
  // shop has to look up somewhere else.
  const metrics: FinanceMetric[] = [
    {
      key: "cash",
      label: "Cash & Bank Balance",
      hint: "Money in the till and at the bank, as at today",
      amountFils: cashAndBankFils,
      delta: null,
      kind: "balance",
    },
    {
      key: "receivable",
      label: "Accounts Receivable",
      hint: "Money customers still owe",
      amountFils: receivableFils,
      delta: null,
      kind: "balance",
    },
    {
      key: "payable",
      label: "Accounts Payable",
      hint: "Money still owed to suppliers",
      amountFils: payableFils,
      delta: null,
      kind: "balance",
    },
    {
      key: "revenue",
      label: "Total Income",
      hint: "Sales for the selected period",
      amountFils: netSalesFils,
      delta: ratioChange(netSalesFils, previousNetSalesFils),
      kind: "period",
    },
    {
      key: "expenses",
      label: "Total Expenses",
      hint: "Operating costs for the period",
      amountFils: operatingExpensesFils,
      delta: ratioChange(operatingExpensesFils, previousOperatingExpensesFils),
      kind: "period",
    },
    {
      key: "netProfit",
      label: "Net Profit",
      hint: "What the period left after every cost",
      amountFils: netProfitFils,
      delta: ratioChange(netProfitFils, previousNetProfitFils),
      kind: "period",
    },
  ];

  const expenseBreakdown = expenseAccounts
    .map((row) => ({ code: row.code, name: row.name, amountFils: periodAmount(row.code) }))
    .filter((row) => row.amountFils !== 0)
    .sort((a, b) => b.amountFils - a.amountFils);

  return {
    asOfDate,
    fromDate,
    toDate,
    previousFromDate,
    previousToDate,
    metrics,
    reconciliation: reconcile(db, asOfDate),
    expenseBreakdown,
    series: tradingSeries(db, fromDate, toDate, granularity),
    cashFlow: cashFlowStatement(db, fromDate, toDate),
    receivableAging: agingReport(db, asOfDate, "receivable"),
    payableAging: agingReport(db, asOfDate, "payable"),
    inventoryValueFils: inventoryFils,
  };
}

/**
 * Change against the previous period.
 *
 * Null when there is nothing to compare against, so the interface can say
 * "no previous data" rather than print a misleading 100% rise off a base of
 * zero.
 */
export function ratioChange(current: Fils, previous: Fils): number | null {
  if (previous === 0) return null;
  return (current - previous) / previous;
}

/* -------------------------------------------------------------------------- */
/* period comparison                                                           */
/* -------------------------------------------------------------------------- */

export interface PeriodComparison {
  readonly fromDate: string;
  readonly toDate: string;
  readonly previousFromDate: string;
  readonly previousToDate: string;
  readonly rows: readonly {
    readonly label: string;
    readonly currentFils: Fils;
    readonly previousFils: Fils;
    readonly changeFils: Fils;
    readonly changePercent: number | null;
  }[];
}

/** This period against the one before it, line by line. */
export function periodComparison(
  db: SqliteDatabase,
  fromDate: string,
  toDate: string,
  previousFromDate: string,
  previousToDate: string,
): PeriodComparison {
  const current = new Map(
    movements(db, fromDate, toDate).map((row) => [row.code, row.balanceFils] as const),
  );
  const previous = new Map(
    movements(db, previousFromDate, previousToDate).map(
      (row) => [row.code, row.balanceFils] as const,
    ),
  );

  const codes = [
    SYSTEM_ACCOUNTS.salesRevenue,
    SYSTEM_ACCOUNTS.salesReturns,
    SYSTEM_ACCOUNTS.costOfGoodsSold,
    SYSTEM_ACCOUNTS.cashInHand,
    SYSTEM_ACCOUNTS.bank,
    SYSTEM_ACCOUNTS.accountsReceivable,
    SYSTEM_ACCOUNTS.accountsPayable,
    SYSTEM_ACCOUNTS.inventory,
  ];

  const names = new Map(
    (db.prepare("SELECT code, name FROM accounts").all() as { code: string; name: string }[]).map(
      (row) => [row.code, row.name] as const,
    ),
  );

  const rows = codes.map((code) => {
    const currentFils = current.get(code) ?? 0;
    const previousFils = previous.get(code) ?? 0;
    return {
      label: names.get(code) ?? code,
      currentFils,
      previousFils,
      changeFils: currentFils - previousFils,
      changePercent:
        previousFils === 0 ? null : ((currentFils - previousFils) / Math.abs(previousFils)) * 100,
    };
  });

  return { fromDate, toDate, previousFromDate, previousToDate, rows };
}

/* -------------------------------------------------------------------------- */
/* cash book                                                                   */
/* -------------------------------------------------------------------------- */

export interface CashBookRow {
  readonly entryId: number;
  readonly entryNo: string;
  readonly entryDate: string;
  readonly description: string;
  readonly reference: string | null;
  readonly receiptFils: Fils;
  readonly paymentFils: Fils;
  readonly balanceFils: Fils;
}

export interface CashBook {
  readonly accountCode: string;
  readonly accountName: string;
  readonly fromDate: string;
  readonly toDate: string;
  readonly openingBalanceFils: Fils;
  readonly rows: readonly CashBookRow[];
  readonly totalReceiptsFils: Fils;
  readonly totalPaymentsFils: Fils;
  readonly closingBalanceFils: Fils;
}

/** The cash book of one cash or bank account. */
export function cashBook(
  db: SqliteDatabase,
  accountCode: string,
  fromDate: string,
  toDate: string,
): CashBook {
  const account = db
    .prepare("SELECT code, name FROM accounts WHERE code = ?")
    .get(accountCode) as { code: string; name: string } | undefined;
  if (account === undefined) throw new Error(`Account ${accountCode} is not in the chart.`);

  const openingBalanceFils = accountBalanceAt(db, accountCode, fromDate);

  const rows = db
    .prepare(
      `SELECT l.entry_id AS entryId, e.entry_no AS entryNo, e.entry_date AS entryDate,
              e.description AS description, e.reference AS reference,
              l.debit_fils AS debit, l.credit_fils AS credit
         FROM journal_lines l
         JOIN journal_entries e ON e.id = l.entry_id
         JOIN accounts a ON a.id = l.account_id
        WHERE a.code = ? AND e.status IN ('posted','reversed')
          AND e.entry_date BETWEEN ? AND ?
        ORDER BY e.entry_date, e.id, l.line_no`,
    )
    .all(accountCode, fromDate, toDate) as {
    entryId: number;
    entryNo: string;
    entryDate: string;
    description: string;
    reference: string | null;
    debit: number;
    credit: number;
  }[];

  let running = openingBalanceFils;
  const mapped: CashBookRow[] = rows.map((row) => {
    running += row.debit - row.credit;
    return {
      entryId: row.entryId,
      entryNo: row.entryNo,
      entryDate: row.entryDate,
      description: row.description,
      reference: row.reference,
      receiptFils: row.debit,
      paymentFils: row.credit,
      balanceFils: running,
    };
  });

  return {
    accountCode: account.code,
    accountName: account.name,
    fromDate,
    toDate,
    openingBalanceFils,
    rows: mapped,
    totalReceiptsFils: mapped.reduce((sum, row) => sum + row.receiptFils, 0),
    totalPaymentsFils: mapped.reduce((sum, row) => sum + row.paymentFils, 0),
    closingBalanceFils: running,
  };
}

/* -------------------------------------------------------------------------- */
/* trial balance, balance sheet and profit and loss                          */
/* -------------------------------------------------------------------------- */

export interface TrialBalanceRowDetail {
  readonly accountId: number;
  readonly code: string;
  readonly name: string;
  readonly type: string;
  readonly subtype: string | null;
  readonly normalBalance: "debit" | "credit";
  readonly openingDebitFils: Fils;
  readonly openingCreditFils: Fils;
  readonly periodDebitFils: Fils;
  readonly periodCreditFils: Fils;
  readonly closingDebitFils: Fils;
  readonly closingCreditFils: Fils;
}

export interface TrialBalanceDetail {
  readonly fromDate: string;
  readonly toDate: string;
  readonly rows: readonly TrialBalanceRowDetail[];
  readonly totalOpeningDebitFils: Fils;
  readonly totalOpeningCreditFils: Fils;
  readonly totalPeriodDebitFils: Fils;
  readonly totalPeriodCreditFils: Fils;
  readonly totalClosingDebitFils: Fils;
  readonly totalClosingCreditFils: Fils;
  readonly isBalanced: boolean;
  readonly differenceFils: Fils;
}

/**
 * The trial balance, with an opening column.
 *
 * The opening column is everything posted before the period, the period
 * columns are the movement inside it, and the closing column is the two added
 * together. A trial balance that only shows the closing figures cannot be
 * checked against last period's, and a shop that has been trading for years
 * needs to see where the year started.
 */
export function detailedTrialBalance(
  db: SqliteDatabase,
  fromDate: string,
  toDate: string,
): TrialBalanceDetail {
  const accounts = db
    .prepare(
      "SELECT id, code, name, type, subtype, normal_balance AS normalBalance FROM accounts ORDER BY code",
    )
    .all() as {
    id: number;
    code: string;
    name: string;
    type: string;
    subtype: string | null;
    normalBalance: "debit" | "credit";
  }[];

  const rows = db
    .prepare(
      `SELECT l.account_id AS accountId,
              SUM(CASE WHEN e.entry_date < ? THEN l.debit_fils ELSE 0 END) AS openingDebit,
              SUM(CASE WHEN e.entry_date < ? THEN l.credit_fils ELSE 0 END) AS openingCredit,
              SUM(CASE WHEN e.entry_date >= ? THEN l.debit_fils ELSE 0 END) AS periodDebit,
              SUM(CASE WHEN e.entry_date >= ? THEN l.credit_fils ELSE 0 END) AS periodCredit
         FROM journal_lines l
         JOIN journal_entries e ON e.id = l.entry_id
        WHERE e.status IN ('posted','reversed') AND e.entry_date <= ?
        GROUP BY l.account_id`,
    )
    .all(fromDate, fromDate, fromDate, fromDate, toDate) as {
    accountId: number;
    openingDebit: number;
    openingCredit: number;
    periodDebit: number;
    periodCredit: number;
  }[];

  const byAccount = new Map(rows.map((row) => [row.accountId, row] as const));

  const mapped: TrialBalanceRowDetail[] = accounts.map((account) => {
    const movement = byAccount.get(account.id);
    const openingDebitFils = movement?.openingDebit ?? 0;
    const openingCreditFils = movement?.openingCredit ?? 0;
    const periodDebitFils = movement?.periodDebit ?? 0;
    const periodCreditFils = movement?.periodCredit ?? 0;

    const openingNet = openingDebitFils - openingCreditFils;
    const closingNet = openingNet + periodDebitFils - periodCreditFils;

    // Which side a balance sits on is decided by the account's own normal
    // balance, not by the sign of the number: revenue of 3,000 belongs in the
    // credit column, and an overdrawn cash account belongs in the credit
    // column even though it is an asset.
    const openingOnDebit =
      account.normalBalance === "debit" ? openingNet >= 0 : openingNet > 0;
    const closingOnDebit =
      account.normalBalance === "debit" ? closingNet >= 0 : closingNet > 0;

    return {
      accountId: account.id,
      code: account.code,
      name: account.name,
      type: account.type,
      subtype: account.subtype,
      normalBalance: account.normalBalance,
      openingDebitFils: openingOnDebit ? Math.abs(openingNet) : 0,
      openingCreditFils: openingOnDebit ? 0 : Math.abs(openingNet),
      periodDebitFils,
      periodCreditFils,
      closingDebitFils: closingOnDebit ? Math.abs(closingNet) : 0,
      closingCreditFils: closingOnDebit ? 0 : Math.abs(closingNet),
    };
  });

  const sum = (pick: (row: TrialBalanceRowDetail) => number): number =>
    mapped.reduce((total, row) => total + pick(row), 0);

  const totalClosingDebitFils = sum((row) => row.closingDebitFils);
  const totalClosingCreditFils = sum((row) => row.closingCreditFils);

  return {
    fromDate,
    toDate,
    rows: mapped,
    totalOpeningDebitFils: sum((row) => row.openingDebitFils),
    totalOpeningCreditFils: sum((row) => row.openingCreditFils),
    totalPeriodDebitFils: sum((row) => row.periodDebitFils),
    totalPeriodCreditFils: sum((row) => row.periodCreditFils),
    totalClosingDebitFils,
    totalClosingCreditFils,
    isBalanced: totalClosingDebitFils === totalClosingCreditFils,
    differenceFils: totalClosingDebitFils - totalClosingCreditFils,
  };
}

export interface FinanceSection {
  readonly heading: string;
  readonly lines: readonly { readonly code: string; readonly name: string; readonly amountFils: Fils }[];
  readonly totalFils: Fils;
}

export interface FinanceBalanceSheet {
  readonly asOfDate: string;
  readonly assets: FinanceSection;
  readonly liabilities: FinanceSection;
  readonly equity: FinanceSection;
  readonly currentPeriodEarningsFils: Fils;
  readonly liabilitiesAndEquityFils: Fils;
  readonly isBalanced: boolean;
  readonly differenceFils: Fils;
}

/**
 * The balance sheet as at a date.
 *
 * Equity carries the retained earnings of earlier periods *plus* the profit of
 * the period being reported. The profit is moved up into equity once, so it is
 * counted exactly once: the income accounts stay in the profit and loss
 * statement and do not appear again on this side.
 */
export function financeBalanceSheet(db: SqliteDatabase, asOfDate: string): FinanceBalanceSheet {
  const rows = movements(db, "0000-01-01", asOfDate);
  const balances = new Map(rows.map((row) => [row.code, row] as const));

  /**
   * The balance as it appears on the statement.
   *
   * A credit-normal account (a liability, equity, revenue) carries a positive
   * balance and increases the side of the equation it belongs to. A
   * debit-normal account inside those classes - the owner's drawings, or
   * accumulated depreciation against fixed assets - reduces them, and is
   * therefore shown as a negative figure rather than quietly added.
   */
  const amount = (code: string, side: "asset" | "liability"): Fils => {
    const row = balances.get(code);
    if (row === undefined) return 0;
    return side === "asset"
      ? row.normalBalance === "debit"
        ? row.balanceFils
        : -row.balanceFils
      : row.normalBalance === "credit"
        ? row.balanceFils
        : -row.balanceFils;
  };

  const build = (
    heading: string,
    entries: readonly { readonly code: string; readonly label: string }[],
    side: "asset" | "liability",
  ): FinanceSection => {
    const lines = entries
      .map((entry) => ({
        code: entry.code,
        name: entry.label,
        amountFils: amount(entry.code, side),
      }))
      .filter((line) => line.amountFils !== 0);
    return {
      heading,
      lines,
      totalFils: lines.reduce((sum, line) => sum + line.amountFils, 0),
    };
  };

  const assets = build(
    "Assets",
    [
      { code: SYSTEM_ACCOUNTS.cashInHand, label: "Cash in Hand" },
      { code: SYSTEM_ACCOUNTS.bank, label: "Bank" },
      { code: SYSTEM_ACCOUNTS.accountsReceivable, label: "Accounts Receivable" },
      { code: SYSTEM_ACCOUNTS.inventory, label: "Inventory" },
      { code: SYSTEM_ACCOUNTS.prepaidExpenses, label: "Prepaid Expenses" },
      { code: SYSTEM_ACCOUNTS.equipment, label: "Equipment & Fixed Assets" },
      { code: SYSTEM_ACCOUNTS.accumulatedDepreciation, label: "Less: Accumulated Depreciation" },
    ],
    "asset",
  );

  const liabilities = build(
    "Liabilities",
    [
      { code: SYSTEM_ACCOUNTS.accountsPayable, label: "Accounts Payable" },
      { code: SYSTEM_ACCOUNTS.supplierAdvances, label: "Supplier Advances" },
      { code: SYSTEM_ACCOUNTS.customerAdvances, label: "Customer Advances" },
      { code: SYSTEM_ACCOUNTS.taxPayable, label: "Tax Payable" },
      { code: SYSTEM_ACCOUNTS.otherCurrentLiabilities, label: "Other Current Liabilities" },
      { code: SYSTEM_ACCOUNTS.longTermLiabilities, label: "Long-Term Liabilities" },
    ],
    "liability",
  );

  const equity = build(
    "Equity",
    [
      { code: SYSTEM_ACCOUNTS.capital, label: "Owner's Capital" },
      { code: SYSTEM_ACCOUNTS.drawings, label: "Less: Owner's Drawings" },
      { code: SYSTEM_ACCOUNTS.retainedEarnings, label: "Retained Earnings" },
    ],
    "liability",
  );

  const currentPeriodEarningsFils = financeProfitAndLoss(db, "0000-01-01", asOfDate).netProfitFils;

  const liabilitiesAndEquityFils =
    liabilities.totalFils + equity.totalFils + currentPeriodEarningsFils;

  return {
    asOfDate,
    assets,
    liabilities,
    equity,
    currentPeriodEarningsFils,
    liabilitiesAndEquityFils,
    isBalanced: assets.totalFils === liabilitiesAndEquityFils,
    differenceFils: assets.totalFils - liabilitiesAndEquityFils,
  };
}

export interface FinanceProfitAndLoss {
  readonly fromDate: string;
  readonly toDate: string;
  readonly grossSalesFils: Fils;
  readonly salesReturnsFils: Fils;
  readonly netSalesFils: Fils;
  readonly costOfGoodsSoldFils: Fils;
  readonly grossProfitFils: Fils;
  readonly grossMarginPercent: number;
  readonly operatingExpensesFils: Fils;
  readonly otherIncomeFils: Fils;
  readonly netProfitFils: Fils;
  readonly expenseLines: readonly { readonly code: string; readonly name: string; readonly amountFils: Fils }[];
  readonly otherIncomeLines: readonly { readonly code: string; readonly name: string; readonly amountFils: Fils }[];
}

/**
 * Profit and loss for a period, from the income and expense accounts only.
 *
 * Deliberately not "cash in less cash out": a credit sale raises no cash and
 * is still revenue, and a cash purchase of inventory is not an expense. Those
 * come from the sales and inventory accounts instead.
 */
export function financeProfitAndLoss(
  db: SqliteDatabase,
  fromDate: string,
  toDate: string,
): FinanceProfitAndLoss {
  const balances = new Map(
    movements(db, fromDate, toDate).map((row) => [row.code, row.balanceFils] as const),
  );
  const raw = (code: string): Fils => balances.get(code) ?? 0;

  const grossSalesFils = raw(SYSTEM_ACCOUNTS.salesRevenue);
  const salesReturnsFils = raw(SYSTEM_ACCOUNTS.salesReturns);
  const costOfGoodsSoldFils = raw(SYSTEM_ACCOUNTS.costOfGoodsSold);

  const expenseRows = db
    .prepare(
      `SELECT code, name FROM accounts
        WHERE type = 'expense' AND is_active = 1 AND code <> ?
        ORDER BY code`,
    )
    .all(SYSTEM_ACCOUNTS.costOfGoodsSold) as { code: string; name: string }[];

  const otherIncomeRows = db
    .prepare(
      `SELECT code, name FROM accounts
        WHERE type = 'income' AND is_active = 1 AND code NOT IN (?, ?)
        ORDER BY code`,
    )
    .all(SYSTEM_ACCOUNTS.salesRevenue, SYSTEM_ACCOUNTS.salesReturns) as {
    code: string;
    name: string;
  }[];

  const expenseLines = expenseRows
    .map((row) => ({ code: row.code, name: row.name, amountFils: raw(row.code) }))
    .filter((line) => line.amountFils !== 0);

  const otherIncomeLines = otherIncomeRows
    .map((row) => ({ code: row.code, name: row.name, amountFils: raw(row.code) }))
    .filter((line) => line.amountFils !== 0);

  const operatingExpensesFils = expenseLines.reduce((sum, line) => sum + line.amountFils, 0);
  const otherIncomeFils = otherIncomeLines.reduce((sum, line) => sum + line.amountFils, 0);

  const netSalesFils = grossSalesFils - salesReturnsFils;
  const grossProfitFils = netSalesFils - costOfGoodsSoldFils;
  const netProfitFils = grossProfitFils - operatingExpensesFils + otherIncomeFils;

  return {
    fromDate,
    toDate,
    grossSalesFils,
    salesReturnsFils,
    netSalesFils,
    costOfGoodsSoldFils,
    grossProfitFils,
    grossMarginPercent:
      netSalesFils === 0 ? 0 : Math.round((grossProfitFils / netSalesFils) * 10000) / 100,
    operatingExpensesFils,
    otherIncomeFils,
    netProfitFils,
    expenseLines,
    otherIncomeLines,
  };
}

/* -------------------------------------------------------------------------- */
/* helpers                                                                     */
/* -------------------------------------------------------------------------- */
/** The months a period covers, used to draw an empty chart with real axes. */
export function monthsInRange(fromDate: string, toDate: string): readonly string[] {
  const months: string[] = [];
  const fromYear = Number.parseInt(fromDate.slice(0, 4), 10);
  const fromMonth = Number.parseInt(fromDate.slice(5, 7), 10);
  const toYear = Number.parseInt(toDate.slice(0, 4), 10);
  const toMonth = Number.parseInt(toDate.slice(5, 7), 10);

  if (!Number.isFinite(fromYear) || !Number.isFinite(toYear)) return months;

  let year = fromYear;
  let month = fromMonth;
  // A guard so a reversed range cannot spin here for ever.
  for (let guard = 0; guard < 600; guard += 1) {
    months.push(`${String(year)}-${String(month).padStart(2, "0")}`);
    if (year === toYear && month === toMonth) break;
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }

  return months;
}

/** Month bounds helper re-exported for callers that build their own ranges. */
export { monthBounds, lastDayOfMonth };
