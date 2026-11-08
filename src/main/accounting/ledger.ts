/**
 * Ledger reports.
 *
 * Every figure here is derived from posted journal entries. Nothing is read from
 * `documents`, `payments` or `expenses` directly, so a report cannot disagree
 * with the ledger: if the two ever did, it would mean a posting was missed, and
 * the reconciliation tests below are what catch that.
 *
 * A balance is reported in the account's own normal balance. "Cash in hand of
 * 6500 fils" means a 6500 debit balance; an overdraft shows as a credit balance
 * on an asset, which is visible rather than silently netted away.
 */

import type { SqliteDatabase } from "../../data/connection";
import type { Fils } from "../../domain/money";
import { SYSTEM_ACCOUNTS } from "./chart";

export interface AccountBalance {
  readonly accountId: number;
  readonly code: string;
  readonly name: string;
  readonly type: string;
  readonly subtype: string | null;
  readonly normalBalance: "debit" | "credit";
  /** Raw movement over the range: debits less credits. */
  readonly movementFils: Fils;
  /** The balance, expressed in the account's own normal balance. */
  readonly balanceFils: Fils;
}

export interface TrialBalanceRow extends AccountBalance {
  readonly debitFils: Fils;
  readonly creditFils: Fils;
}

export interface TrialBalance {
  readonly fromDate: string;
  readonly toDate: string;
  readonly rows: readonly TrialBalanceRow[];
  readonly totalDebitFils: Fils;
  readonly totalCreditFils: Fils;
  readonly isBalanced: boolean;
  /** Positive when debits exceed credits. Should always be zero. */
  readonly differenceFils: Fils;
}

interface MovementRow {
  readonly accountId: number;
  readonly code: string;
  readonly name: string;
  readonly type: string;
  readonly subtype: string | null;
  readonly normalBalance: "debit" | "credit";
  readonly debitFils: number;
  readonly creditFils: number;
}

const MOVEMENT_SQL = `
  SELECT a.id AS accountId, a.code AS code, a.name AS name, a.type AS type,
         a.subtype AS subtype, a.normal_balance AS normalBalance,
         COALESCE(SUM(l.debit_fils), 0) AS debitFils,
         COALESCE(SUM(l.credit_fils), 0) AS creditFils
    FROM accounts a
    LEFT JOIN journal_lines l ON l.account_id = a.id
    LEFT JOIN journal_entries e ON e.id = l.entry_id
   WHERE (e.id IS NULL OR (e.status IN ('posted','reversed') AND e.entry_date BETWEEN ? AND ?))
   GROUP BY a.id
   ORDER BY a.code
`;

/**
 * Debit and credit movement per account over a date range.
 *
 * Accounts with no movement in the range still appear, with zeroes, because a
 * trial balance that silently omits an account cannot be added up by eye.
 */
export function movements(
  db: SqliteDatabase,
  fromDate: string,
  toDate: string,
): readonly AccountBalance[] {
  const rows = db.prepare(MOVEMENT_SQL).all(fromDate, toDate) as MovementRow[];

  return rows.map((row) => {
    const movementFils = row.debitFils - row.creditFils;
    const balanceFils =
      row.normalBalance === "debit" ? movementFils : -movementFils;
    return {
      accountId: row.accountId,
      code: row.code,
      name: row.name,
      type: row.type,
      subtype: row.subtype,
      normalBalance: row.normalBalance,
      movementFils,
      // `+ 0` turns a negative zero into a zero, so a balance of nothing
      // reads as nothing rather than as "-0" in a table cell.
      balanceFils: balanceFils + 0,
    };
  });
}

/** Cumulative balance of one account up to and including `toDate`. */
export function accountBalanceAt(
  db: SqliteDatabase,
  code: string,
  toDate: string,
): Fils {
  const row = db
    .prepare(
      `SELECT a.normal_balance AS normalBalance,
              COALESCE(SUM(l.debit_fils), 0) AS debit,
              COALESCE(SUM(l.credit_fils), 0) AS credit
         FROM accounts a
         LEFT JOIN journal_lines l ON l.account_id = a.id
         LEFT JOIN journal_entries e ON e.id = l.entry_id
        WHERE a.code = ? AND (e.id IS NULL OR (e.status IN ('posted','reversed')
                                             AND e.entry_date <= ?))
        GROUP BY a.id`,
    )
    .get(code, toDate) as { normalBalance: "debit" | "credit"; debit: number; credit: number } | undefined;

  if (row === undefined) return 0;
  const movement = row.debit - row.credit;
  return row.normalBalance === "debit" ? movement : -movement;
}

/**
 * Trial balance for a period.
 *
 * Opening balance is everything posted up to the day before `fromDate`; the
 * period columns are the movement between the two dates; closing is the sum of
 * the two.
 */
export function trialBalance(db: SqliteDatabase, fromDate: string, toDate: string): TrialBalance {
  const period = new Map(
    movements(db, fromDate, toDate).map((balance) => [balance.code, balance] as const),
  );

  // Everything before the period starts, per account.
  const openingRows = db
    .prepare(
      `SELECT a.code AS code, a.normal_balance AS normalBalance,
              COALESCE(SUM(l.debit_fils), 0) AS debit,
              COALESCE(SUM(l.credit_fils), 0) AS credit
         FROM accounts a
         LEFT JOIN journal_lines l ON l.account_id = a.id
         LEFT JOIN journal_entries e ON e.id = l.entry_id
        WHERE (e.id IS NULL OR (e.status IN ('posted','reversed') AND e.entry_date < ?))
        GROUP BY a.id`,
    )
    .all(fromDate) as { code: string; normalBalance: "debit" | "credit"; debit: number; credit: number }[];

  const opening = new Map(
    openingRows.map((row) => {
      const movement = row.debit - row.credit;
      // `+ 0` turns a negative zero into a zero: a balance of nothing should
      // read as nothing, not as "-0" in a table cell.
      return [
        row.code,
        (row.normalBalance === "debit" ? movement : -movement) + 0,
      ] as const;
    }),
  );

  const accounts = db
    .prepare("SELECT id, code, name, type, subtype, normal_balance AS normalBalance FROM accounts ORDER BY code")
    .all() as {
    id: number;
    code: string;
    name: string;
    type: string;
    subtype: string | null;
    normalBalance: "debit" | "credit";
  }[];

  const rows: TrialBalanceRow[] = [];
  for (const account of accounts) {
    const openingFils = opening.get(account.code) ?? 0;
    const move = period.get(account.code);
    const movementFils = move?.movementFils ?? 0;
    const closingFils =
      openingFils + (account.normalBalance === "debit" ? movementFils : -movementFils) + 0;

    // Which column a balance sits in is decided by the account's normal
    // balance, not by the sign: "Sales Revenue 3000" belongs in the credit
    // column even though 3000 is positive, and an overdrawn cash account belongs
    // in the credit column even though it is an asset.
    const onDebitSide =
      account.normalBalance === "debit" ? closingFils >= 0 : closingFils < 0;

    rows.push({
      accountId: account.id,
      code: account.code,
      name: account.name,
      type: account.type,
      subtype: account.subtype,
      normalBalance: account.normalBalance,
      movementFils,
      balanceFils: closingFils,
      debitFils: onDebitSide ? Math.abs(closingFils) : 0,
      creditFils: onDebitSide ? 0 : Math.abs(closingFils),
    });
  }

  const totalDebitFils = rows.reduce((sum, row) => sum + row.debitFils, 0);
  const totalCreditFils = rows.reduce((sum, row) => sum + row.creditFils, 0);

  return {
    fromDate,
    toDate,
    rows,
    totalDebitFils,
    totalCreditFils,
    isBalanced: totalDebitFils === totalCreditFils,
    differenceFils: totalDebitFils - totalCreditFils,
  };
}

export interface BalanceSheetLine {
  readonly code: string;
  readonly name: string;
  readonly amountFils: Fils;
}

export interface BalanceSheetSection {
  readonly heading: string;
  readonly lines: readonly BalanceSheetLine[];
  readonly totalFils: Fils;
}

export interface BalanceSheet {
  readonly asOfDate: string;
  readonly assets: BalanceSheetSection;
  readonly liabilities: BalanceSheetSection;
  readonly equity: BalanceSheetSection;
  readonly liabilitiesAndEquityFils: Fils;
  readonly isBalanced: boolean;
  readonly differenceFils: Fils;
}

/**
 * Balance sheet as at a date.
 *
 * Equity carries retained earnings *plus* the current period's profit, which is
 * what "current period earnings" is for. The profit is deliberately not also
 * left sitting in the income accounts on this side: it is moved up here once, so
 * it is counted exactly once.
 */
export function balanceSheet(db: SqliteDatabase, asOfDate: string): BalanceSheet {
  const balances = new Map(
    movements(db, "0000-01-01", asOfDate).map((balance) => [balance.code, balance.balanceFils] as const),
  );
  const amount = (code: string): Fils => balances.get(code) ?? 0;

  const assets = section("Assets", [
    [SYSTEM_ACCOUNTS.cashInHand, "Cash in Hand"],
    [SYSTEM_ACCOUNTS.bank, "Bank"],
    [SYSTEM_ACCOUNTS.accountsReceivable, "Accounts Receivable"],
    [SYSTEM_ACCOUNTS.inventory, "Inventory"],
    [SYSTEM_ACCOUNTS.prepaidExpenses, "Prepaid Expenses"],
    [SYSTEM_ACCOUNTS.equipment, "Equipment & Fixed Assets"],
  ].map(([code, label]) => ({ code: code as string, label: label as string })), (code) => amount(code), "asset");

  const liabilities = section("Liabilities", [
    { code: SYSTEM_ACCOUNTS.accountsPayable, label: "Accounts Payable" },
    { code: SYSTEM_ACCOUNTS.supplierAdvances, label: "Supplier Advances" },
    { code: SYSTEM_ACCOUNTS.customerAdvances, label: "Customer Advances" },
    { code: SYSTEM_ACCOUNTS.taxPayable, label: "Tax Payable" },
    { code: SYSTEM_ACCOUNTS.otherCurrentLiabilities, label: "Other Current Liabilities" },
    { code: SYSTEM_ACCOUNTS.longTermLiabilities, label: "Long-Term Liabilities" },
  ], (code) => -amount(code), "liability");

  // Current period earnings: everything closed to profit and loss, moved up
  // into equity once. Retained earnings holds what earlier periods left.
  const periodProfit = profitAndLoss(db, "0000-01-01", asOfDate).netProfitFils;

  const equity = section("Equity", [
    { code: SYSTEM_ACCOUNTS.capital, label: "Owner's Capital" },
    { code: SYSTEM_ACCOUNTS.drawings, label: "Owner's Drawings" },
    { code: SYSTEM_ACCOUNTS.retainedEarnings, label: "Retained Earnings" },
  ], (code) => -amount(code), "equity");

  const liabilitiesAndEquityFils =
    liabilities.totalFils + equity.totalFils + periodProfit;

  return {
    asOfDate,
    assets,
    liabilities,
    equity,
    liabilitiesAndEquityFils,
    isBalanced: assets.totalFils === liabilitiesAndEquityFils,
    differenceFils: assets.totalFils - liabilitiesAndEquityFils,
  };
}

function section(
  heading: string,
  entries: readonly { code: string; label: string }[],
  amountFor: (code: string) => Fils,
  type: string,
): BalanceSheetSection {
  const lines: BalanceSheetLine[] = [];
  for (const entry of entries) {
    const amountFils = amountFor(entry.code);
    if (amountFils === 0) continue;
    // Assets read naturally positive; contra and credit classes are negated by
    // the caller so a displayed figure is what a person would say out loud.
    void type;
    lines.push({ code: entry.code, name: entry.label, amountFils: Math.abs(amountFils) });
  }
  return {
    heading,
    lines,
    totalFils: lines.reduce((sum, line) => sum + line.amountFils, 0),
  };
}

export interface ProfitLossStatement {
  readonly fromDate: string;
  readonly toDate: string;
  readonly grossSalesFils: Fils;
  readonly salesReturnsFils: Fils;
  readonly netSalesFils: Fils;
  readonly costOfGoodsSoldFils: Fils;
  readonly grossProfitFils: Fils;
  readonly operatingExpensesFils: Fils;
  readonly otherIncomeFils: Fils;
  readonly netProfitFils: Fils;
  readonly expenseLines: readonly BalanceSheetLine[];
  readonly otherIncomeLines: readonly BalanceSheetLine[];
}

/**
 * Profit and loss for a period, from the income and expense accounts only.
 *
 * Deliberately not "cash in less cash out": a credit sale raises no cash and is
 * still revenue, and a cash purchase of inventory is not an expense. Those come
 * from the sales and inventory accounts instead.
 */
export function profitAndLoss(db: SqliteDatabase, fromDate: string, toDate: string): ProfitLossStatement {
  const balances = new Map(
    movements(db, fromDate, toDate).map((balance) => [balance.code, balance.balanceFils] as const),
  );
  const raw = (code: string): Fils => balances.get(code) ?? 0;

  const grossSalesFils = raw(SYSTEM_ACCOUNTS.salesRevenue);
  const salesReturnsFils = raw(SYSTEM_ACCOUNTS.salesReturns);
  const costOfGoodsSoldFils = raw(SYSTEM_ACCOUNTS.costOfGoodsSold);

  // Income and expense accounts carry a credit / debit normal balance
  // respectively, so `balanceFils` is already signed the useful way: revenue
  // positive, expense positive.
  const expenseRows = db
    .prepare(
      `SELECT a.code AS code, a.name AS name
         FROM accounts a
        WHERE a.type = 'expense' AND a.is_active = 1 AND a.code <> ?
        ORDER BY a.code`,
    )
    .all(SYSTEM_ACCOUNTS.costOfGoodsSold) as { code: string; name: string }[];

  const otherIncomeRows = db
    .prepare(
      `SELECT a.code AS code, a.name AS name
         FROM accounts a
        WHERE a.type = 'income' AND a.is_active = 1
          AND a.code NOT IN (?, ?)
        ORDER BY a.code`,
    )
    .all(SYSTEM_ACCOUNTS.salesRevenue, SYSTEM_ACCOUNTS.salesReturns) as {
    code: string;
    name: string;
  }[];

  const expenseLines: BalanceSheetLine[] = expenseRows
    .map((row) => ({ code: row.code, name: row.name, amountFils: raw(row.code) }))
    .filter((line) => line.amountFils !== 0);

  const otherIncomeLines: BalanceSheetLine[] = otherIncomeRows
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
    operatingExpensesFils,
    otherIncomeFils,
    netProfitFils,
    expenseLines,
    otherIncomeLines,
  };
}

/**
 * Customer and supplier control balances, taken from the subledger lines.
 *
 * The control account and the sum of its parties must agree; `reconcile` is what
 * asserts that rather than assuming it.
 */
export function subledgerBalances(
  db: SqliteDatabase,
  toDate: string,
): { receivableFromParties: Fils; payableToParties: Fils } {
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN a.code = ? THEN l.debit_fils - l.credit_fils ELSE 0 END), 0) AS receivable,
         COALESCE(SUM(CASE WHEN a.code = ? THEN l.credit_fils - l.debit_fils ELSE 0 END), 0) AS payable
       FROM journal_lines l
       JOIN journal_entries e ON e.id = l.entry_id
       JOIN accounts a ON a.id = l.account_id
      WHERE l.party_id IS NOT NULL AND e.status IN ('posted','reversed') AND e.entry_date <= ?`,
    )
    .get(SYSTEM_ACCOUNTS.accountsReceivable, SYSTEM_ACCOUNTS.accountsPayable, toDate) as {
    receivable: number;
    payable: number;
  };

  return { receivableFromParties: row.receivable, payableToParties: row.payable };
}

export interface Reconciliation {
  readonly asOfDate: string;
  readonly receivableControlFils: Fils;
  readonly receivableFromPartiesFils: Fils;
  readonly receivableMatches: boolean;
  readonly payableControlFils: Fils;
  readonly payableFromPartiesFils: Fils;
  readonly payableMatches: boolean;
}

/** Compare each control account against the sum of its party subledger. */
export function reconcile(db: SqliteDatabase, asOfDate: string): Reconciliation {
  const receivableControlFils = accountBalanceAt(db, SYSTEM_ACCOUNTS.accountsReceivable, asOfDate);
  // No sign flip here: `accountBalanceAt` already expresses a balance in the
  // account's own normal balance, so a payable of 1000 comes back as +1000.
  const payableControlFils = accountBalanceAt(db, SYSTEM_ACCOUNTS.accountsPayable, asOfDate);
  const subledger = subledgerBalances(db, asOfDate);

  return {
    asOfDate,
    receivableControlFils,
    receivableFromPartiesFils: subledger.receivableFromParties,
    receivableMatches: receivableControlFils === subledger.receivableFromParties,
    payableControlFils,
    payableFromPartiesFils: subledger.payableToParties,
    payableMatches: payableControlFils === subledger.payableToParties,
  };
}
