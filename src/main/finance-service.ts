/**
 * The Finance module's service layer.
 *
 * Everything the Finance screens need, in one place: the Chart of Accounts,
 * the journal, the ledgers and the reports. The handlers in `rpc.ts` are thin
 * wrappers around this file - they validate the payload and check the
 * permission, and nothing else.
 *
 * Two rules run through all of it:
 *
 *  - Money is integer fils from the database to the screen. The currency
 *    symbol is added in the renderer, in one place, so a report and a card
 *    cannot disagree about the same figure.
 *  - Every figure comes from posted journal entries. Nothing is read from the
 *    business tables for a financial total, so a report cannot drift away
 *    from the ledger.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SqliteDatabase } from "../data/connection";
import type { Fils } from "../domain/money";
import type {
  AccountDto,
  AccountingPeriodDto,
  AgingDto,
  BalanceSheetDto,
  CashBookDto,
  CashFlowDto,
  ExportDataset,
  FinanceOverviewDto,
  GeneralLedgerDto,
  JournalEntryDetailDto,
  JournalEntryRowDto,
  JournalSource,
  JournalStatus,
  LedgerLineDto,
  MigrationAuditDto,
  PartyBalanceDto,
  PartyLedgerKind,
  PartyStatementDto,
  PeriodComparisonDto,
  ProfitLossDto,
  SaveAccountRequest,
  SaveJournalEntryRequest,
  SaveJournalLineRequest,
  TrialBalanceDto,
} from "../shared/finance";
import type { ExpenseDto, PaymentDto, DocumentDto } from "../shared/types";
import {
  AccountError,
  deleteAccount,
  exportChart,
  listAccounts,
  saveAccount,
  setAccountActive,
} from "./accounting/accounts";
import {
  deleteDraft,
  listJournalEntries,
  postDraft,
  postEntry,
  readEntryDetail,
  reverseEntry,
  updateDraft,
  type JournalEntryInput,
  type JournalLine,
} from "./accounting/posting";
import {
  agingReport,
  cashBook,
  cashFlowStatement,
  detailedTrialBalance,
  financeBalanceSheet,
  financeOverview,
  financeProfitAndLoss,
  generalLedger,
  partyStatement,
  periodComparison,
  type SeriesGranularity,
} from "./accounting/reports";
import { SYSTEM_ACCOUNTS } from "./accounting/chart";
import {
  cashAccountFor,
  expenseEntrySpecs,
  paymentEntrySpecs,
  purchaseEntrySpecs,
  saleEntrySpecs,
} from "./accounting/service";
import { syncEntry, type EntrySpec } from "./accounting/sync";
import { reconcile } from "./accounting/ledger";
import { listPartners, recordPartnerSplit } from "./repositories/partners";
import { partnerSplit } from "./repositories/reports";

export { AccountError };

/* -------------------------------------------------------------------------- */
/* the two postings the service writes itself                                  */
/* -------------------------------------------------------------------------- */

/**
 * One opening posting: what the books start with.
 *
 * Balances are taken by account code rather than as a single figure, because
 * the trial balance is only balanced when the caller's numbers are, and that
 * should be checked here rather than discovered on the first report.
 */
function openingEntrySpec(
  entryDate: string,
  balances: readonly {
    readonly accountCode: string;
    readonly debitFils: number;
    readonly creditFils: number;
  }[],
): EntrySpec {
  const lines: EntrySpec["lines"][number][] = balances
    .filter((line) => line.debitFils > 0 || line.creditFils > 0)
    .map((line) => ({
      accountCode: line.accountCode,
      ...(line.debitFils > 0
        ? { debitFils: line.debitFils }
        : { creditFils: line.creditFils }),
      description: "Opening balance",
    }));

  return {
    baseKey: `opening:${entryDate}`,
    entryDate,
    description: "Opening balances",
    source: "opening",
    lines,
  };
}

/**
 * Cash to bank, or bank to cash.
 *
 * Never income and never an expense: both sides are assets, so the entry
 * moves money between them and the profit and loss statement is untouched.
 */
function transferEntrySpec(
  entryDate: string,
  reference: string | undefined,
  from: string,
  to: string,
  amountFils: number,
): EntrySpec {
  return {
    baseKey: `transfer:${entryDate}:${from}:${to}:${String(amountFils)}`,
    entryDate,
    description: `Transfer ${from} to ${to}`,
    source: "transfer",
    lines: [
      { accountCode: to, debitFils: amountFils, description: reference ?? "Transfer in" },
      { accountCode: from, creditFils: amountFils, description: reference ?? "Transfer out" },
    ],
  };
}

/** Which side of the ledger a party sits on. */
function kindOfParty(db: SqliteDatabase, partyId: number): "customer" | "supplier" {
  const row = db.prepare("SELECT kind FROM parties WHERE id = ?").get(partyId) as
    | { kind: string }
    | undefined;
  return row?.kind === "supplier" ? "supplier" : "customer";
}
/* -------------------------------------------------------------------------- */
/* chart of accounts                                                           */
/* -------------------------------------------------------------------------- */

export function readChart(db: SqliteDatabase): AccountDto[] {
  return listAccounts(db);
}

export function writeChart(
  db: SqliteDatabase,
  request: SaveAccountRequest,
  nowIso: string,
): AccountDto {
  return saveAccount(db, request, nowIso);
}

export function toggleChartAccount(
  db: SqliteDatabase,
  id: number,
  isActive: boolean,
  nowIso: string,
): AccountDto {
  return setAccountActive(db, id, isActive, nowIso);
}

export function removeChartAccount(db: SqliteDatabase, id: number, nowIso: string): void {
  deleteAccount(db, id, nowIso);
}

/* -------------------------------------------------------------------------- */
/* journal                                                                     */
/* -------------------------------------------------------------------------- */

export function readJournal(
  db: SqliteDatabase,
  request: {
    fromDate?: string | undefined;
    toDate?: string | undefined;
    source?: JournalSource | undefined;
    status?: JournalStatus | undefined;
    search?: string | undefined;
    accountCode?: string | undefined;
    limit?: number | undefined;
  },
): JournalEntryRowDto[] {
  return [...listJournalEntries(db, request)];
}

export function readJournalEntry(db: SqliteDatabase, id: number): JournalEntryDetailDto {
  return readEntryDetail(db, id);
}

function toJournalLines(
  lines: readonly SaveJournalLineRequest[],
): JournalLine[] {
  return lines.map((line) => ({
    accountCode: line.accountCode,
    debitFils: line.debitFils,
    creditFils: line.creditFils,
    ...(line.description === undefined || line.description === null
      ? {}
      : { description: line.description }),
  }));
}

/**
 * Create or change a manual journal entry.
 *
 * A draft may be edited; a posted entry may not. That is enforced by the
 * engine, and the screen is told the difference rather than being left to
 * guess.
 */
export function writeJournal(
  db: SqliteDatabase,
  request: SaveJournalEntryRequest,
  nowIso: string,
  createdBy: string | undefined,
): JournalEntryDetailDto {
  const lines = toJournalLines(request.lines);

  const input: JournalEntryInput = {
    entryDate: request.entryDate,
    description: request.description,
    source: "manual",
    lines,
    ...(request.reference === undefined || request.reference === null
      ? {}
      : { reference: request.reference }),
    ...(createdBy === undefined ? {} : { createdBy }),
  };

  if (request.id !== undefined) {
    const existing = db
      .prepare("SELECT status FROM journal_entries WHERE id = ?")
      .get(request.id) as { status: JournalStatus } | undefined;
    if (existing === undefined) {
      throw new AccountError("That journal entry was not found.");
    }
    if (existing.status !== "draft") {
      throw new AccountError(
        "A posted entry cannot be edited. Reverse it and post a correcting entry instead.",
      );
    }
    updateDraft({ db, nowIso, createdBy }, request.id, input);
    if (request.postNow === true) postDraft({ db, nowIso, createdBy }, request.id);
    return readEntryDetail(db, request.id);
  }

  const entry = postEntry(
    { db, nowIso, createdBy },
    {
      ...input,
      status: request.postNow === true ? "posted" : "draft",
      sourceKey: `manual:${String(nowIso)}:${String(request.entryDate)}`,
    },
  );

  if (request.postNow !== true) {
    // A draft created through this path is a real entry with a real number.
    // The source key is unique per creation, so a second draft is a second
    // entry rather than an overwrite of the first.
  }

  return readEntryDetail(db, entry.id);
}

/** Post a draft, after re-checking that it still balances and is in an open period. */
export function publishJournal(
  db: SqliteDatabase,
  id: number,
  nowIso: string,
  createdBy: string | undefined,
): JournalEntryDetailDto {
  postDraft({ db, nowIso, createdBy }, id);
  return readEntryDetail(db, id);
}

/**
 * Reverse a posted entry.
 *
 * The original is never edited or deleted: it is marked reversed and a
 * mirror-image entry is posted beside it, so the audit trail shows both.
 */
export function reverseJournal(
  db: SqliteDatabase,
  id: number,
  reason: string,
  nowIso: string,
  nowDate: string,
  createdBy: string | undefined,
): JournalEntryDetailDto {
  return readEntryDetail(db, reverseEntry({ db, nowIso, createdBy }, id, reason, nowDate).id);
}

export function discardDraft(
  db: SqliteDatabase,
  id: number,
  nowIso: string,
  createdBy: string | undefined,
): void {
  deleteDraft({ db, nowIso, createdBy }, id);
}

/* -------------------------------------------------------------------------- */
/* ledgers and reports                                                         */
/* -------------------------------------------------------------------------- */

export function readGeneralLedger(
  db: SqliteDatabase,
  code: string,
  fromDate: string,
  toDate: string,
): GeneralLedgerDto {
  const ledger = generalLedger(db, code, fromDate, toDate);
  return {
    code: ledger.code,
    name: ledger.name,
    type: ledger.type as GeneralLedgerDto["type"],
    normalBalance: ledger.normalBalance,
    fromDate: ledger.fromDate,
    toDate: ledger.toDate,
    openingBalanceFils: ledger.openingBalanceFils,
    rows: ledger.rows.map((row) => ({
      ...row,
      source: row.source as LedgerLineDto["source"],
      status: row.status,
    })),
    totalDebitFils: ledger.totalDebitFils,
    totalCreditFils: ledger.totalCreditFils,
    closingBalanceFils: ledger.closingBalanceFils,
  };
}

export function readTrialBalance(
  db: SqliteDatabase,
  fromDate: string,
  toDate: string,
): TrialBalanceDto {
  const detail = detailedTrialBalance(db, fromDate, toDate);
  return {
    fromDate,
    toDate,
    rows: detail.rows.map((row) => ({
      accountId: row.accountId,
      code: row.code,
      name: row.name,
      type: row.type as TrialBalanceDto["rows"][number]["type"],
      subtype: row.subtype as TrialBalanceDto["rows"][number]["subtype"],
      normalBalance: row.normalBalance,
      openingDebitFils: row.openingDebitFils,
      openingCreditFils: row.openingCreditFils,
      periodDebitFils: row.periodDebitFils,
      periodCreditFils: row.periodCreditFils,
      closingDebitFils: row.closingDebitFils,
      closingCreditFils: row.closingCreditFils,
    })),
    totalOpeningDebitFils: detail.totalOpeningDebitFils,
    totalOpeningCreditFils: detail.totalOpeningCreditFils,
    totalPeriodDebitFils: detail.totalPeriodDebitFils,
    totalPeriodCreditFils: detail.totalPeriodCreditFils,
    totalClosingDebitFils: detail.totalClosingDebitFils,
    totalClosingCreditFils: detail.totalClosingCreditFils,
    isBalanced: detail.isBalanced,
    differenceFils: detail.differenceFils,
  };
}

export function readBalanceSheet(db: SqliteDatabase, asOfDate: string): BalanceSheetDto {
  const sheet = financeBalanceSheet(db, asOfDate);
  return {
    asOfDate,
    assets: {
      heading: sheet.assets.heading,
      lines: sheet.assets.lines.map((line) => ({
        code: line.code,
        name: line.name,
        amountFils: line.amountFils,
      })),
      totalFils: sheet.assets.totalFils,
    },
    liabilities: {
      heading: sheet.liabilities.heading,
      lines: sheet.liabilities.lines.map((line) => ({
        code: line.code,
        name: line.name,
        amountFils: line.amountFils,
      })),
      totalFils: sheet.liabilities.totalFils,
    },
    equity: {
      heading: sheet.equity.heading,
      lines: sheet.equity.lines.map((line) => ({
        code: line.code,
        name: line.name,
        amountFils: line.amountFils,
      })),
      totalFils: sheet.equity.totalFils,
    },
    currentPeriodEarningsFils: sheet.currentPeriodEarningsFils,
    liabilitiesAndEquityFils: sheet.liabilitiesAndEquityFils,
    isBalanced: sheet.isBalanced,
    differenceFils: sheet.differenceFils,
  };
}

export function readProfitAndLoss(
  db: SqliteDatabase,
  fromDate: string,
  toDate: string,
): ProfitLossDto {
  const pnl = financeProfitAndLoss(db, fromDate, toDate);
  return {
    fromDate,
    toDate,
    grossSalesFils: pnl.grossSalesFils,
    salesReturnsFils: pnl.salesReturnsFils,
    netSalesFils: pnl.netSalesFils,
    costOfGoodsSoldFils: pnl.costOfGoodsSoldFils,
    grossProfitFils: pnl.grossProfitFils,
    grossMarginPercent: pnl.grossMarginPercent,
    operatingExpensesFils: pnl.operatingExpensesFils,
    otherIncomeFils: pnl.otherIncomeFils,
    netProfitFils: pnl.netProfitFils,
    expenseLines: pnl.expenseLines.map((line) => ({ ...line })),
    otherIncomeLines: pnl.otherIncomeLines.map((line) => ({ ...line })),
  };
}

export function readCashFlow(db: SqliteDatabase, fromDate: string, toDate: string): CashFlowDto {
  const flow = cashFlowStatement(db, fromDate, toDate);
  return {
    fromDate,
    toDate,
    openingCashFils: flow.openingCashFils,
    operating: {
      heading: flow.operating.heading,
      lines: flow.operating.rows.map((row) => ({ code: "", name: row.label, amountFils: row.amountFils })),
      totalFils: flow.operating.totalFils,
    },
    investing: {
      heading: flow.investing.heading,
      lines: flow.investing.rows.map((row) => ({ code: "", name: row.label, amountFils: row.amountFils })),
      totalFils: flow.investing.totalFils,
    },
    financing: {
      heading: flow.financing.heading,
      lines: flow.financing.rows.map((row) => ({ code: "", name: row.label, amountFils: row.amountFils })),
      totalFils: flow.financing.totalFils,
    },
    netMovementFils: flow.netMovementFils,
    closingCashFils: flow.closingCashFils,
    totalReceivedFils: flow.totalReceivedFils,
    totalPaidFils: flow.totalPaidFils,
  };
}

export function readAging(
  db: SqliteDatabase,
  asOfDate: string,
  side: "receivable" | "payable",
): AgingDto {
  const aging = agingReport(db, asOfDate, side);
  return {
    asOfDate,
    side,
    rows: aging.rows.map((row) => ({ ...row })),
    buckets: aging.totals.map((bucket) => ({
      key: bucket.bucket,
      label: bucket.label,
      amountFils: bucket.amountFils,
    })),
    totalOutstandingFils: aging.totalOutstandingFils,
    totalOverdueFils: aging.totalOverdueFils,
  };
}

export function readPartyStatement(
  db: SqliteDatabase,
  partyId: number,
  kind: PartyLedgerKind,
  fromDate: string,
  toDate: string,
): PartyStatementDto {
  const statement = partyStatement(db, partyId, kind, fromDate, toDate);
  return {
    partyId: statement.partyId,
    partyName: statement.partyName,
    kind: statement.kind,
    fromDate: statement.fromDate,
    toDate: statement.toDate,
    openingBalanceFils: statement.openingBalanceFils,
    rows: statement.rows.map((row) => ({ ...row })),
    totalDebitFils: statement.totalDebitFils,
    totalCreditFils: statement.totalCreditFils,
    closingBalanceFils: statement.closingBalanceFils,
    overdueFils: statement.overdueFils,
  };
}

/**
 * Every customer or supplier, with what they owe or are owed.
 *
 * Read from the journal rather than from the invoice tables, so the list and
 * the control account are the same numbers by construction.
 */
export function readPartyBalances(
  db: SqliteDatabase,
  kind: PartyLedgerKind,
  asOfDate: string,
): PartyBalanceDto[] {
  const control = kind === "customer" ? "1020" : "2000";

  const rows = db
    .prepare(
      `SELECT p.id, p.name,
              COALESCE(SUM(l.debit_fils - l.credit_fils), 0) AS net
         FROM parties p
         JOIN journal_lines l ON l.party_id = p.id
         JOIN journal_entries e ON e.id = l.entry_id
         JOIN accounts a ON a.id = l.account_id
        WHERE a.code = ? AND e.status IN ('posted','reversed') AND e.entry_date <= ?
        GROUP BY p.id
        ORDER BY p.name`,
    )
    .all(control, asOfDate) as { id: number; name: string; net: number }[];

  const invoiceRows = db
    .prepare(
      `SELECT party_id AS partyId, COUNT(*) AS count
         FROM documents
        WHERE kind = ? AND status IN ('issued','partPaid') AND gross_fils > paid_fils
        GROUP BY party_id`,
    )
    .all(kind === "customer" ? "invoice" : "purchaseInvoice") as {
    partyId: number;
    count: number;
  }[];

  const invoiceCounts = new Map(invoiceRows.map((row) => [row.partyId, row.count] as const));

  const lastRows = db
    .prepare(
      `SELECT party_id AS partyId, MAX(e.entry_date) AS lastDate
         FROM journal_lines l
         JOIN journal_entries e ON e.id = l.entry_id
         JOIN accounts a ON a.id = l.account_id
        WHERE a.code = ? AND e.status IN ('posted','reversed')
        GROUP BY party_id`,
    )
    .all(control) as { partyId: number; lastDate: string | null }[];
  const lastDates = new Map(lastRows.map((row) => [row.partyId, row.lastDate] as const));

  // The aging report knows which invoices are late.
  const aging = agingReport(db, asOfDate, kind === "customer" ? "receivable" : "payable");
  const overdueByParty = new Map<number, Fils>();
  for (const row of aging.rows) {
    if (row.bucket === "notDue") continue;
    overdueByParty.set(
      row.partyId,
      (overdueByParty.get(row.partyId) ?? 0) + row.outstandingFils,
    );
  }

  return rows
    .map((row) => {
      const outstandingFils = kind === "customer" ? row.net : -row.net;
      return {
        partyId: row.id,
        partyName: row.name,
        kind,
        outstandingFils,
        overdueFils: overdueByParty.get(row.id) ?? 0,
        invoiceCount: invoiceCounts.get(row.id) ?? 0,
        lastTransactionDate: lastDates.get(row.id) ?? null,
      };
    })
    .filter((row) => row.outstandingFils !== 0 || row.invoiceCount > 0);
}

export function readCashBook(
  db: SqliteDatabase,
  accountCode: string,
  fromDate: string,
  toDate: string,
): CashBookDto {
  const book = cashBook(db, accountCode, fromDate, toDate);
  return {
    accountCode: book.accountCode,
    accountName: book.accountName,
    fromDate: book.fromDate,
    toDate: book.toDate,
    openingBalanceFils: book.openingBalanceFils,
    rows: book.rows.map((row) => ({ ...row })),
    totalReceiptsFils: book.totalReceiptsFils,
    totalPaymentsFils: book.totalPaymentsFils,
    closingBalanceFils: book.closingBalanceFils,
  };
}

export function readPeriodComparison(
  db: SqliteDatabase,
  fromDate: string,
  toDate: string,
  previousFromDate: string,
  previousToDate: string,
): PeriodComparisonDto {
  const comparison = periodComparison(db, fromDate, toDate, previousFromDate, previousToDate);
  return {
    fromDate: comparison.fromDate,
    toDate: comparison.toDate,
    previousFromDate: comparison.previousFromDate,
    previousToDate: comparison.previousToDate,
    rows: comparison.rows.map((row) => ({ ...row })),
  };
}

export function readOverview(
  db: SqliteDatabase,
  request: {
    fromDate: string;
    toDate: string;
    asOfDate: string;
    previousFromDate: string;
    previousToDate: string;
    granularity?: SeriesGranularity | undefined;
  },
): FinanceOverviewDto {
  const overview = financeOverview(
    db,
    request.fromDate,
    request.toDate,
    request.asOfDate,
    request.previousFromDate,
    request.previousToDate,
    request.granularity ?? "month",
  );

  const reconciliation = reconcile(db, request.asOfDate);

  return {
    asOfDate: overview.asOfDate,
    fromDate: overview.fromDate,
    toDate: overview.toDate,
    previousFromDate: overview.previousFromDate,
    previousToDate: overview.previousToDate,
    metrics: overview.metrics.map((metric) => ({ ...metric })),
    reconciliation: {
      asOfDate: reconciliation.asOfDate,
      receivableControlFils: reconciliation.receivableControlFils,
      receivableFromPartiesFils: reconciliation.receivableFromPartiesFils,
      receivableMatches: reconciliation.receivableMatches,
      payableControlFils: reconciliation.payableControlFils,
      payableFromPartiesFils: reconciliation.payableFromPartiesFils,
      payableMatches: reconciliation.payableMatches,
    },
    expenseBreakdown: overview.expenseBreakdown.map((row) => ({ ...row })),
    series: overview.series.map((point) => ({ ...point })),
    cashFlow: readCashFlow(db, request.fromDate, request.toDate),
    receivableAging: readAging(db, request.asOfDate, "receivable"),
    payableAging: readAging(db, request.asOfDate, "payable"),
    inventoryValueFils: overview.inventoryValueFils,
  };
}

/* -------------------------------------------------------------------------- */
/* money movement                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Move money between the cash and bank accounts.
 *
 * Both sides are assets, so this is never income and never an expense: the
 * profit and loss statement is untouched by a transfer.
 */
export function recordTransfer(
  db: SqliteDatabase,
  request: {
    transferDate: string;
    fromAccountCode: string;
    toAccountCode: string;
    amountFils: number;
    reference?: string | null | undefined;
  },
  nowIso: string,
  createdBy: string | undefined,
): void {
  if (request.fromAccountCode === request.toAccountCode) {
    throw new AccountError("Choose two different accounts to move money between.");
  }

  const spec = transferEntrySpec(
    request.transferDate,
    request.reference ?? undefined,
    request.fromAccountCode,
    request.toAccountCode,
    request.amountFils,
  );

  syncEntry({ db, nowIso, createdBy }, spec);
}

/**
 * Post the opening balances of the books.
 *
 * The entry is balanced before it is written: an unbalanced opening balance
 * would make every later report wrong in a way that is very hard to trace
 * back, so it is refused here rather than at the first trial balance.
 */
export function recordOpeningBalances(
  db: SqliteDatabase,
  request: {
    entryDate: string;
    balances: readonly {
      readonly accountCode: string;
      readonly debitFils: number;
      readonly creditFils: number;
    }[];
  },
  nowIso: string,
  createdBy: string | undefined,
): void {
  const totalDebit = request.balances.reduce((sum, line) => sum + line.debitFils, 0);
  const totalCredit = request.balances.reduce((sum, line) => sum + line.creditFils, 0);

  if (totalDebit !== totalCredit) {
    throw new AccountError(
      "Opening balances must add up. The debits and the credits are different amounts.",
    );
  }
  if (totalDebit === 0) {
    throw new AccountError("There is nothing to post. Enter at least one balance.");
  }

  const spec = openingEntrySpec(request.entryDate, request.balances);
  syncEntry({ db, nowIso, createdBy }, spec);
}

/* -------------------------------------------------------------------------- */
/* export                                                                      */
/* -------------------------------------------------------------------------- */

function csvCell(value: string | number): string {
  const text = typeof value === "number" ? String(value) : value;
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvRows(rows: readonly (readonly (string | number)[])[]): string {
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
}

/**
 * Write a report out as a CSV file.
 *
 * The rows are built here rather than in the renderer, so what is written is
 * exactly what the report showed - not a second, slightly different
 * calculation of the same thing.
 */
export function exportFinanceReport(
  db: SqliteDatabase,
  exportDir: string,
  request: {
    dataset: ExportDataset;
    fromDate?: string | undefined;
    toDate?: string | undefined;
    accountCode?: string | undefined;
    partyId?: number | undefined;
    partyKind?: PartyLedgerKind | undefined;
  },
): string {
  const from = request.fromDate ?? "0001-01-01";
  const to = request.toDate ?? "9999-12-31";
  const stamp = `${request.fromDate ?? "all"}_${request.toDate ?? "all"}`;

  let rows: readonly (readonly (string | number)[])[];
  let filename: string;

  switch (request.dataset) {
    case "chartOfAccounts": {
      rows = [
        ["Code", "Account", "Type", "Sub-type", "Parent", "Normal balance", "System", "Active", "Balance"],
        ...exportChart(db).map((row) => [
          row.code,
          row.name,
          row.type,
          row.subtype ?? "",
          row.parent ?? "",
          row.normalBalance,
          row.isSystem ? "Yes" : "No",
          row.isActive ? "Yes" : "No",
          (row.balanceFils / 100).toFixed(2),
        ]),
      ];
      filename = `chart-of-accounts-${stamp}.csv`;
      break;
    }
    case "trialBalance": {
      const trial = readTrialBalance(db, from, to);
      rows = [
        ["Code", "Account", "Opening debit", "Opening credit", "Period debit", "Period credit", "Closing debit", "Closing credit"],
        ...trial.rows.map((row) => [
          row.code,
          row.name,
          (row.openingDebitFils / 100).toFixed(2),
          (row.openingCreditFils / 100).toFixed(2),
          (row.periodDebitFils / 100).toFixed(2),
          (row.periodCreditFils / 100).toFixed(2),
          (row.closingDebitFils / 100).toFixed(2),
          (row.closingCreditFils / 100).toFixed(2),
        ]),
        [
          "Total",
          "",
          (trial.totalOpeningDebitFils / 100).toFixed(2),
          (trial.totalOpeningCreditFils / 100).toFixed(2),
          (trial.totalPeriodDebitFils / 100).toFixed(2),
          (trial.totalPeriodCreditFils / 100).toFixed(2),
          (trial.totalClosingDebitFils / 100).toFixed(2),
          (trial.totalClosingCreditFils / 100).toFixed(2),
        ],
      ];
      filename = `trial-balance-${stamp}.csv`;
      break;
    }
    case "balanceSheet": {
      const sheet = readBalanceSheet(db, to);
      const section = (heading: string, lines: readonly { code: string; name: string; amountFils: number }[]): (string | number)[][] => [
        [heading, ""],
        ...lines.map((line) => ["  " + line.name, (line.amountFils / 100).toFixed(2)]),
        ["  Total " + heading.toLowerCase(), (lines.reduce((sum, line) => sum + line.amountFils, 0) / 100).toFixed(2)],
        [],
      ];
      rows = [
        [`Balance sheet as at ${to}`, ""],
        [],
        ...section(sheet.assets.heading, sheet.assets.lines),
        ...section(sheet.liabilities.heading, sheet.liabilities.lines),
        ...section(sheet.equity.heading, sheet.equity.lines),
        ["Profit for the period", (sheet.currentPeriodEarningsFils / 100).toFixed(2)],
        ["Total liabilities and equity", (sheet.liabilitiesAndEquityFils / 100).toFixed(2)],
      ];
      filename = `balance-sheet-${stamp}.csv`;
      break;
    }
    case "profitAndLoss": {
      const pnl = readProfitAndLoss(db, from, to);
      rows = [
        [`Profit and loss ${from} to ${to}`, ""],
        [],
        ["Gross sales", (pnl.grossSalesFils / 100).toFixed(2)],
        ["Sales returns and allowances", (pnl.salesReturnsFils / 100).toFixed(2)],
        ["Net sales", (pnl.netSalesFils / 100).toFixed(2)],
        ["Cost of goods sold", (pnl.costOfGoodsSoldFils / 100).toFixed(2)],
        ["Gross profit", (pnl.grossProfitFils / 100).toFixed(2)],
        [],
        ["Operating expense", "Amount"],
        ...pnl.expenseLines.map((line) => [line.name, (line.amountFils / 100).toFixed(2)]),
        ["Total operating expenses", (pnl.operatingExpensesFils / 100).toFixed(2)],
        [],
        ["Other income", "Amount"],
        ...pnl.otherIncomeLines.map((line) => [line.name, (line.amountFils / 100).toFixed(2)]),
        ["Total other income", (pnl.otherIncomeFils / 100).toFixed(2)],
        [],
        ["Net profit", (pnl.netProfitFils / 100).toFixed(2)],
      ];
      filename = `profit-and-loss-${stamp}.csv`;
      break;
    }
    case "cashFlow": {
      const flow = readCashFlow(db, from, to);
      const section = (heading: string, lines: readonly { name: string; amountFils: number }[]): (string | number)[][] => [
        [heading, ""],
        ...lines.map((line) => ["  " + line.name, (line.amountFils / 100).toFixed(2)]),
        ["  Total", (lines.reduce((sum, line) => sum + line.amountFils, 0) / 100).toFixed(2)],
        [],
      ];
      rows = [
        [`Cash flow ${from} to ${to}`, ""],
        [],
        ["Opening cash and bank", (flow.openingCashFils / 100).toFixed(2)],
        [],
        ...section(flow.operating.heading, flow.operating.lines),
        ...section(flow.investing.heading, flow.investing.lines),
        ...section(flow.financing.heading, flow.financing.lines),
        ["Net movement", (flow.netMovementFils / 100).toFixed(2)],
        ["Closing cash and bank", (flow.closingCashFils / 100).toFixed(2)],
      ];
      filename = `cash-flow-${stamp}.csv`;
      break;
    }
    case "generalLedger": {
      const code = request.accountCode ?? "1000";
      const ledger = readGeneralLedger(db, code, from, to);
      rows = [
        [`General ledger - ${ledger.name} (${ledger.code})`, `${from} to ${to}`],
        [],
        ["Date", "Entry", "Reference", "Description", "Debit", "Credit", "Balance"],
        ...ledger.rows.map((row) => [
          row.entryDate,
          row.entryNo,
          row.reference ?? "",
          row.description ?? "",
          (row.debitFils / 100).toFixed(2),
          (row.creditFils / 100).toFixed(2),
          (row.runningBalanceFils / 100).toFixed(2),
        ]),
        [],
        ["Opening balance", "", "", "", "", "", (ledger.openingBalanceFils / 100).toFixed(2)],
        ["Total", "", "", "", (ledger.totalDebitFils / 100).toFixed(2), (ledger.totalCreditFils / 100).toFixed(2), (ledger.closingBalanceFils / 100).toFixed(2)],
      ];
      filename = `general-ledger-${code}-${stamp}.csv`;
      break;
    }
    case "journalRegister": {
      const entries = listJournalEntries(db, {
        fromDate: request.fromDate,
        toDate: request.toDate,
        limit: 5000,
      });
      rows = [
        ["Entry", "Date", "Reference", "Description", "Source", "Status", "Debit", "Credit"],
        ...entries.map((entry) => [
          entry.entryNo,
          entry.entryDate,
          entry.reference ?? "",
          entry.description,
          entry.source,
          entry.status,
          (entry.totalDebitFils / 100).toFixed(2),
          (entry.totalCreditFils / 100).toFixed(2),
        ]),
      ];
      filename = `journal-register-${stamp}.csv`;
      break;
    }
    case "receivableAging":
    case "payableAging": {
      const side = request.dataset === "receivableAging" ? "receivable" : "payable";
      const aging = readAging(db, to, side);
      rows = [
        [`${side === "receivable" ? "Customer" : "Supplier"} aging as at ${to}`, ""],
        [],
        ["Bucket", "Amount"],
        ...aging.buckets.map((bucket) => [bucket.label, (bucket.amountFils / 100).toFixed(2)]),
        ["Total outstanding", (aging.totalOutstandingFils / 100).toFixed(2)],
        [],
        ["Invoice", "Party", "Issue date", "Due date", "Total", "Paid", "Outstanding", "Days overdue"],
        ...aging.rows.map((row) => [
          row.documentNumber,
          row.partyName,
          row.issueDate,
          row.dueDate ?? "",
          (row.totalFils / 100).toFixed(2),
          (row.paidFils / 100).toFixed(2),
          (row.outstandingFils / 100).toFixed(2),
          row.daysOverdue,
        ]),
      ];
      filename = `${side}-aging-${stamp}.csv`;
      break;
    }
    case "cashBook": {
      const book = readCashBook(db, request.accountCode ?? "1000", from, to);
      rows = [
        [`Cash book - ${book.accountName}`, `${from} to ${to}`],
        [],
        ["Date", "Entry", "Description", "Reference", "Receipts", "Payments", "Balance"],
        ...book.rows.map((row) => [
          row.entryDate,
          row.entryNo,
          row.description,
          row.reference ?? "",
          (row.receiptFils / 100).toFixed(2),
          (row.paymentFils / 100).toFixed(2),
          (row.balanceFils / 100).toFixed(2),
        ]),
        [],
        ["Opening balance", "", "", "", "", "", (book.openingBalanceFils / 100).toFixed(2)],
        ["Total", "", "", "", (book.totalReceiptsFils / 100).toFixed(2), (book.totalPaymentsFils / 100).toFixed(2), (book.closingBalanceFils / 100).toFixed(2)],
      ];
      filename = `cash-book-${book.accountCode}-${stamp}.csv`;
      break;
    }
    case "expenseBreakdown": {
      const overview = readOverview(db, {
        fromDate: from,
        toDate: to,
        asOfDate: to,
        previousFromDate: from,
        previousToDate: to,
      });
      rows = [
        [`Expense breakdown ${from} to ${to}`, ""],
        [],
        ["Account", "Code", "Amount"],
        ...overview.expenseBreakdown.map((line) => [
          line.name,
          line.code,
          (line.amountFils / 100).toFixed(2),
        ]),
      ];
      filename = `expense-breakdown-${stamp}.csv`;
      break;
    }
    case "customerStatement":
    case "supplierStatement": {
      const kind: PartyLedgerKind = request.dataset === "customerStatement" ? "customer" : "supplier";
      const partyId = request.partyId ?? 0;
      const statement = readPartyStatement(db, partyId, kind, from, to);
      rows = [
        [`${kind === "customer" ? "Customer" : "Supplier"} statement - ${statement.partyName}`, `${from} to ${to}`],
        [],
        ["Date", "Entry", "Reference", "Description", "Debit", "Credit", "Balance"],
        ...statement.rows.map((row) => [
          row.entryDate,
          row.entryNo,
          row.documentNumber ?? row.reference ?? "",
          row.description,
          (row.debitFils / 100).toFixed(2),
          (row.creditFils / 100).toFixed(2),
          (row.runningBalanceFils / 100).toFixed(2),
        ]),
        [],
        ["Opening balance", "", "", "", "", "", (statement.openingBalanceFils / 100).toFixed(2)],
        ["Closing balance", "", "", "", "", "", (statement.closingBalanceFils / 100).toFixed(2)],
      ];
      filename = `${kind}-statement-${String(partyId)}-${stamp}.csv`;
      break;
    }
    case "periodComparison": {
      const comparison = readPeriodComparison(db, from, to, from, to);
      rows = [
        [`Period comparison ${from} to ${to}`, ""],
        [],
        ["Account", "Current", "Previous", "Change", "Change %"],
        ...comparison.rows.map((row) => [
          row.label,
          (row.currentFils / 100).toFixed(2),
          (row.previousFils / 100).toFixed(2),
          (row.changeFils / 100).toFixed(2),
          row.changePercent === null ? "" : row.changePercent.toFixed(1),
        ]),
      ];
      filename = `period-comparison-${stamp}.csv`;
      break;
    }
  }

  const path = join(exportDir, filename);
  writeFileSync(path, `${csvRows(rows)}\r\n`, "utf8");
  return path;
}

/* -------------------------------------------------------------------------- */
/* accounting periods                                                          */
/* -------------------------------------------------------------------------- */

export function listPeriods(db: SqliteDatabase): AccountingPeriodDto[] {
  const rows = db
    .prepare(
      `SELECT id, name, start_date AS startDate, end_date AS endDate, status, closed_at AS closedAt
         FROM accounting_periods
        ORDER BY start_date`,
    )
    .all() as {
    id: number;
    name: string;
    startDate: string;
    endDate: string;
    status: "open" | "closed";
    closedAt: string | null;
  }[];

  return rows;
}

/**
 * Create or change an accounting period.
 *
 * A closed period is the guard rail that stops a month's figures being
 * quietly rewritten after they have been reported on, so its dates cannot be
 * changed once it is closed.
 */
export function savePeriod(
  db: SqliteDatabase,
  request: {
    id?: number | undefined;
    name: string;
    startDate: string;
    endDate: string;
  },
  _nowIso: string,
): AccountingPeriodDto {
  if (request.endDate < request.startDate) {
    throw new AccountError("The period must end on or after it starts.");
  }

  const existing =
    request.id === undefined
      ? undefined
      : (db
          .prepare("SELECT id, status FROM accounting_periods WHERE id = ?")
          .get(request.id) as { id: number; status: string } | undefined);

  if (existing !== undefined && existing.status === "closed") {
    throw new AccountError(
      "A closed period cannot be changed. Reopen it first if you need to move its dates.",
    );
  }

  if (existing === undefined) {
    db.prepare(
      `INSERT INTO accounting_periods (name, start_date, end_date, status)
       VALUES (?, ?, ?, 'open')`,
    ).run(request.name, request.startDate, request.endDate);
  } else {
    db.prepare(
      "UPDATE accounting_periods SET name = ?, start_date = ?, end_date = ? WHERE id = ?",
    ).run(request.name, request.startDate, request.endDate, request.id);
  }

  const saved = db
    .prepare("SELECT id FROM accounting_periods WHERE name = ?")
    .get(request.name) as { id: number };

  return {
    id: saved.id,
    name: request.name,
    startDate: request.startDate,
    endDate: request.endDate,
    status: "open",
    closedAt: null,
  };
}

export function closePeriod(
  db: SqliteDatabase,
  id: number,
  nowIso: string,
  closedBy: string,
  actor?: { id: number; name: string },
): AccountingPeriodDto {
  const row = db
    .prepare("SELECT id, name, start_date, end_date, status FROM accounting_periods WHERE id = ?")
    .get(id) as
    | { id: number; name: string; start_date: string; end_date: string; status: string }
    | undefined;
  if (row === undefined) throw new AccountError("That accounting period was not found.");

  db.prepare(
    "UPDATE accounting_periods SET status = 'closed', closed_at = ?, closed_by = ? WHERE id = ?",
  ).run(nowIso, closedBy, id);

  // Closing the books for a period is the moment the profit for that period
  // is final, so the split is written down now: each partner's share and the
  // donation that goes with it. A period with no profit, or with no partners,
  // has nothing to record.
  recordSplitForPeriod(db, row.start_date, row.end_date, nowIso, closedBy, actor);

  return {
    id: row.id,
    name: row.name,
    startDate: row.start_date,
    endDate: row.end_date,
    status: "closed",
    closedAt: nowIso,
  };
}

/**
 * Write the partner split for a closed period into the partnership's ledger.
 *
 * Nothing is written when the period made no profit or when no partners take
 * a share. A split that cannot be worked out - because the donation and the
 * partners' shares do not come to 100% - stops the period being closed,
 * rather than closing a period whose profit cannot be accounted for.
 */
function recordSplitForPeriod(
  db: SqliteDatabase,
  fromDate: string,
  toDate: string,
  nowIso: string,
  createdBy: string,
  actor: { id: number; name: string } | undefined,
): void {
  const donationRow = db
    .prepare("SELECT value FROM settings WHERE key = 'donation_rate_percent'")
    .get() as { value: string } | undefined;
  const configured = Number(donationRow?.value);
  const donationRatePercent = Number.isFinite(configured) ? configured : 2;

  const split = partnerSplit(db, fromDate, toDate, listPartners(db), { donationRatePercent });

  if (split.configurationError !== null) {
    throw new AccountError(
      `The profit split for ${fromDate} to ${toDate} could not be worked out: ${split.configurationError}`,
    );
  }

  if (split.netProfitFils <= 0 || split.partners.length === 0) return;

  const periodRef = `${fromDate}..${toDate}`;
  const already = db
    .prepare(
      "SELECT COUNT(*) AS count FROM partner_transactions WHERE period_ref = ? AND kind IN ('profit','donation')",
    )
    .get(periodRef) as { count: number };
  if (already.count > 0) return;

  recordPartnerSplit(
    { db, actor: actor ?? { id: 0, name: createdBy }, nowIso, nowDate: toDate },
    {
      fromDate,
      toDate,
      netProfitFils: split.netProfitFils,
      donationFils: split.donationFils,
      partners: split.partners.map((partner) => ({
        partnerId: partner.partnerId,
        partnerName: partner.name,
        sharePercent: partner.sharePercent,
        amountFils: partner.amountFils,
      })),
    },
  );
}

export function reopenPeriod(
  db: SqliteDatabase,
  id: number,
  _nowIso: string,
  _closedBy: string,
): AccountingPeriodDto {
  const row = db
    .prepare("SELECT id, name, start_date, end_date, status FROM accounting_periods WHERE id = ?")
    .get(id) as
    | { id: number; name: string; start_date: string; end_date: string; status: string }
    | undefined;
  if (row === undefined) throw new AccountError("That accounting period was not found.");

  db.prepare(
    "UPDATE accounting_periods SET status = 'open', closed_at = NULL, closed_by = NULL WHERE id = ?",
  ).run(id);

  return {
    id: row.id,
    name: row.name,
    startDate: row.start_date,
    endDate: row.end_date,
    status: "open",
    closedAt: null,
  };
}

/* -------------------------------------------------------------------------- */
/* existing data                                                               */
/* -------------------------------------------------------------------------- */

/**
 * What the existing data looks like to the accounting engine.
 *
 * Reported honestly rather than fixed silently: a shop that traded before the
 * Finance module existed has documents, payments and expenses that carry no
 * journal entry, and the count of each is exactly what the back-fill needs to
 * know.
 */
export function migrationAudit(db: SqliteDatabase): MigrationAuditDto {
  const count = (sql: string, ...params: (string | number)[]): number =>
    (db.prepare(sql).get(...params) as { n: number }).n;

  const documentsWithEntry = count(
    `SELECT COUNT(*) AS n FROM documents d
      WHERE EXISTS (SELECT 1 FROM journal_entries e
                     JOIN journal_lines l ON l.entry_id = e.id
                    WHERE l.document_id = d.id AND e.status IN ('posted','reversed'))`,
  );
  const documentsTotal = count(
    "SELECT COUNT(*) AS n FROM documents WHERE kind IN ('invoice','purchaseInvoice') AND status <> 'cancelled'",
  );

  const paymentsWithEntry = count(
    `SELECT COUNT(*) AS n FROM payments p
      WHERE EXISTS (SELECT 1 FROM journal_entries e
                     JOIN journal_lines l ON l.entry_id = e.id
                    WHERE e.source_key = 'payment:' || p.id)`,
  );
  const paymentsTotal = count("SELECT COUNT(*) AS n FROM payments");

  const expensesWithEntry = count(
    `SELECT COUNT(*) AS n FROM expenses x
      WHERE EXISTS (SELECT 1 FROM journal_entries e
                     WHERE e.source_key = 'expense:' || x.id)`,
  );
  const expensesTotal = count("SELECT COUNT(*) AS n FROM expenses");

  // Records that cannot be posted accurately: a document with no cost
  // recorded cannot have its cost of goods sold worked out, and a document
  // with no party cannot have its receivable attached to anybody.
  const unmigratable: { kind: string; reference: string; reason: string }[] = [];

  const noCost = db
    .prepare(
      `SELECT number, kind, cost_fils AS costFils
         FROM documents
        WHERE kind = 'invoice' AND status <> 'cancelled' AND cost_fils = 0
          AND EXISTS (SELECT 1 FROM document_lines dl WHERE dl.document_id = documents.id AND dl.product_id IS NOT NULL)
        ORDER BY number
        LIMIT 50`,
    )
    .all() as { number: string; kind: string; costFils: number }[];

  for (const row of noCost) {
    unmigratable.push({
      kind: "sale",
      reference: row.number,
      reason: "No cost was recorded for the goods sold, so the cost of goods sold cannot be worked out.",
    });
  }

  const stockValueFils = count(
    `SELECT COALESCE(SUM(quantity_milli * average_cost_fils / 1000), 0) AS n FROM products WHERE is_active = 1`,
  );

  const inventoryRow = db
    .prepare(
      `SELECT COALESCE(SUM(l.debit_fils - l.credit_fils), 0) AS n
         FROM journal_lines l
         JOIN accounts a ON a.id = l.account_id
         JOIN journal_entries e ON e.id = l.entry_id
        WHERE a.code = ? AND e.status IN ('posted','reversed')`,
    )
    .get(SYSTEM_ACCOUNTS.inventory) as { n: number };

  return {
    hasAccountingHistory: documentsWithEntry + paymentsWithEntry + expensesWithEntry > 0,
    documentsWithoutEntry: Math.max(0, documentsTotal - documentsWithEntry),
    paymentsWithoutEntry: Math.max(0, paymentsTotal - paymentsWithEntry),
    expensesWithoutEntry: Math.max(0, expensesTotal - expensesWithEntry),
    documentsWithEntry,
    paymentsWithEntry,
    expensesWithEntry,
    unmigratable,
    stockValueFils,
    inventoryAccountFils: inventoryRow.n,
    inventoryMatches: Math.abs(stockValueFils - inventoryRow.n) <= 100,
  };
}

/**
 * Post the journal entries for the records that predate the Finance module.
 *
 * Idempotent: a record that already has an entry is left alone, so running
 * this twice changes nothing the second time. The entries are posted from the
 * amounts the business records already hold - the invoice totals, the
 * recorded line costs, the payment amounts - so nothing is invented.
 */
export function backfillHistory(
  db: SqliteDatabase,
  confirm: boolean,
  nowIso: string,
  nowDate: string,
  createdBy: string,
): { posted: number; skipped: number } {
  if (!confirm) {
    throw new AccountError("Confirm the back-fill before it runs.");
  }

  const ctx = { db, nowIso, nowDate, createdBy };
  let posted = 0;
  let skipped = 0;

  const documents = db
    .prepare(
      `SELECT id FROM documents
        WHERE kind IN ('invoice','purchaseInvoice') AND status <> 'cancelled'
        ORDER BY id`,
    )
    .all() as { id: number }[];

  for (const row of documents) {
    const already = db
      .prepare(
        `SELECT COUNT(*) AS n FROM journal_lines l
           JOIN journal_entries e ON e.id = l.entry_id
          WHERE l.document_id = ? AND e.status IN ('posted','reversed')`,
      )
      .get(row.id) as { n: number };
    if (already.n > 0) {
      skipped += 1;
      continue;
    }

    const document = getDocumentForPosting(db, row.id);
    if (document === null) {
      skipped += 1;
      continue;
    }

    const specs =
      document.kind === "purchaseInvoice"
        ? purchaseEntrySpecs(document as unknown as DocumentDto)
        : saleEntrySpecs(document as unknown as DocumentDto, cashAccountFor("cash"));

    for (const spec of specs) {
      syncEntry(ctx, spec);
    }
    posted += 1;
  }

  const payments = db.prepare("SELECT id FROM payments ORDER BY id").all() as { id: number }[];
  for (const row of payments) {
    const already = db
      .prepare("SELECT COUNT(*) AS n FROM journal_entries WHERE source_key = ?")
      .get(`payment:${String(row.id)}`) as { n: number };
    if (already.n > 0) {
      skipped += 1;
      continue;
    }
    const payment = getPaymentForPosting(db, row.id);
    if (payment === null) {
      skipped += 1;
      continue;
    }
    const spec = paymentEntrySpecs(payment, kindOfParty(db, payment.partyId))[0];
    if (spec === undefined) {
      skipped += 1;
      continue;
    }
    syncEntry(ctx, spec);
    posted += 1;
  }

  const expenses = db.prepare("SELECT id FROM expenses ORDER BY id").all() as { id: number }[];
  for (const row of expenses) {
    const already = db
      .prepare("SELECT COUNT(*) AS n FROM journal_entries WHERE source_key = ?")
      .get(`expense:${String(row.id)}`) as { n: number };
    if (already.n > 0) {
      skipped += 1;
      continue;
    }
    const expense = getExpenseForPosting(db, row.id);
    if (expense === null) {
      skipped += 1;
      continue;
    }
    const spec = expenseEntrySpecs(expense)[0];
    if (spec === undefined) {
      skipped += 1;
      continue;
    }
    syncEntry(ctx, spec);
    posted += 1;
  }

  return { posted, skipped };
}

/* -------------------------------------------------------------------------- */
/* helpers                                                                     */
/* -------------------------------------------------------------------------- */

interface DocumentForPosting {
  readonly id: number;
  readonly kind: "invoice" | "purchaseInvoice";
  readonly number: string;
  readonly partyId: number | null;
  readonly issueDate: string;
  readonly netFils: number;
  readonly vatFils: number;
  readonly grossFils: number;
  readonly paidFils: number;
  readonly costFils: number;
  readonly lines: readonly { readonly quantityMilli: number }[];
}

function getDocumentForPosting(db: SqliteDatabase, id: number): DocumentForPosting | null {
  const row = db
    .prepare(
      `SELECT id, kind, number, party_id AS partyId, issue_date AS issueDate,
              net_fils AS netFils, vat_fils AS vatFils, gross_fils AS grossFils,
              paid_fils AS paidFils, cost_fils AS costFils
         FROM documents WHERE id = ?`,
    )
    .get(id) as DocumentForPosting | undefined;
  if (row === undefined) return null;

  const lines = db
    .prepare("SELECT quantity_milli AS quantityMilli FROM document_lines WHERE document_id = ?")
    .all(id) as { quantityMilli: number }[];

  return { ...row, lines };
}

function getPaymentForPosting(db: SqliteDatabase, id: number): PaymentDto | null {
  const row = db
    .prepare(
      `SELECT id, direction, party_id AS partyId, payment_date AS paymentDate, method,
              amount_fils AS amountFils, reference, notes
         FROM payments WHERE id = ?`,
    )
    .get(id) as PaymentDto | undefined;
  return row ?? null;
}

function getExpenseForPosting(
  db: SqliteDatabase,
  id: number,
): ExpenseDto | null {
  const row = db
    .prepare(
      `SELECT id, expense_date AS expenseDate, category, description,
              amount_fils AS amountFils, vat_fils AS vatFils, payment_method AS paymentMethod,
              reference, notes
         FROM expenses WHERE id = ?`,
    )
    .get(id) as ExpenseDto | null | undefined;
  return row ?? null;
}

/** Which side of the ledger a party sits on. */
export { kindOfParty as partyKindOf };

/** The payments the Finance screens list. Re-exported for the RPC layer. */
export type { PaymentDto };
