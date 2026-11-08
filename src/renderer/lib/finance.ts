/**
 * Finance helpers for the renderer.
 *
 * The date presets live here rather than in a page, because the dashboard, the
 * reports and the ledgers all offer the same range picker and must agree on
 * what "this month" means.
 *
 * Every preset also produces the *previous* period of the same length. That is
 * what the comparison figures on the dashboard are measured against, and
 * deriving it from the same rule is the only way the two can be trusted to be
 * the same length - a percentage change between periods of different sizes
 * says nothing.
 */

import { IMS_PATH } from "./ims-nav";

export type DateRangePreset =
  "today" | "week" | "month" | "lastMonth" | "quarter" | "year" | "custom";

export interface DateRange {
  readonly fromDate: string;
  readonly toDate: string;
  /** The period immediately before this one, of the same length. */
  readonly previousFromDate: string;
  readonly previousToDate: string;
  /** The date the balances are read at. */
  readonly asOfDate: string;
  readonly label: string;
}

export const DATE_RANGE_PRESETS: readonly {
  readonly value: DateRangePreset;
  readonly label: string;
}[] = [
  { value: "today", label: "Today" },
  { value: "week", label: "This week" },
  { value: "month", label: "This month" },
  { value: "quarter", label: "This quarter" },
  { value: "year", label: "This year" },
  { value: "custom", label: "Custom" },
];

const pad = (value: number): string => String(value).padStart(2, "0");

export function toIso(date: Date): string {
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function startOfWeek(date: Date): Date {
  const copy = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  // Monday-first, which is what a shop calendar uses.
  const weekday = (copy.getDay() + 6) % 7;
  copy.setDate(copy.getDate() - weekday);
  return copy;
}

function startOfQuarter(date: Date): Date {
  const month = date.getMonth();
  const firstMonth = Math.floor(month / 3) * 3;
  return new Date(date.getFullYear(), firstMonth, 1);
}

function startOfYear(date: Date): Date {
  return new Date(date.getFullYear(), 0, 1);
}

function addDays(date: Date, days: number): Date {
  const copy = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  copy.setDate(copy.getDate() + days);
  return copy;
}

function previousPeriod(from: Date, to: Date): { readonly from: Date; readonly to: Date } {
  // The previous period is the same number of days, ending the day before
  // this one starts. A month is measured in days rather than in calendar
  // months so that a comparison is never between two different lengths.
  const days = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;
  const previousTo = addDays(from, -1);
  const previousFrom = addDays(previousTo, -(days - 1));
  return { from: previousFrom, to: previousTo };
}

/**
 * Turn a preset into a concrete range.
 *
 * A custom range keeps its own dates and still gets a previous period of the
 * same length, so the comparison figures work the same way whatever the user
 * picked.
 */
export function resolveDateRange(
  preset: DateRangePreset,
  customFrom: string,
  customTo: string,
  now: Date = new Date(),
): DateRange {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  let from: Date;
  let to: Date;
  let label: string;

  switch (preset) {
    case "today":
      from = today;
      to = today;
      label = "Today";
      break;
    case "week":
      from = startOfWeek(today);
      to = today;
      label = "This week";
      break;
    case "lastMonth": {
      // The calendar month before this one, not the same number of days back:
      // a month has a length, and "last month" means the month that ended.
      const firstOfThisMonth = new Date(today.getFullYear(), today.getMonth(), 1);
      from = new Date(firstOfThisMonth.getFullYear(), firstOfThisMonth.getMonth() - 1, 1);
      to = new Date(firstOfThisMonth.getTime() - 1);
      label = "Last month";
      break;
    }
    case "quarter":
      from = startOfQuarter(today);
      to = today;
      label = "This quarter";
      break;
    case "year":
      from = startOfYear(today);
      to = today;
      label = "This year";
      break;
    case "custom": {
      const parsedFrom = customFrom.length > 0 ? new Date(`${customFrom}T00:00:00`) : today;
      const parsedTo = customTo.length > 0 ? new Date(`${customTo}T00:00:00`) : today;
      from = parsedFrom;
      to = parsedTo;
      label = `${customFrom || toIso(today)} → ${customTo || toIso(today)}`;
      break;
    }
    case "month":
    default:
      from = new Date(today.getFullYear(), today.getMonth(), 1);
      to = today;
      label = "This month";
      break;
  }

  const previous = previousPeriod(from, to);

  return {
    fromDate: toIso(from),
    toDate: toIso(to),
    previousFromDate: toIso(previous.from),
    previousToDate: toIso(previous.to),
    asOfDate: toIso(to),
    label,
  };
}

/* -------------------------------------------------------------------------- */
/* navigation                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The Finance module's own tabs.
 *
 * The module has ten screens, which is far too many entries for the sidebar,
 * so they live behind one "Finance" item and a row of tabs inside it.
 */
export interface FinanceTab {
  readonly path: string;
  readonly label: string;
  readonly hint: string;
}

export const FINANCE_TABS: readonly FinanceTab[] = [
  {
    path: IMS_PATH.financeOverview,
    label: "Overview",
    hint: "Where the business stands right now",
  },
  {
    path: IMS_PATH.accounts,
    label: "Chart of Accounts",
    hint: "The accounts the ledger is kept in",
  },
  { path: IMS_PATH.accountLedger, label: "Account Ledger", hint: "Every movement on one account" },
  { path: IMS_PATH.journal, label: "Journal Entries", hint: "The raw record of every posting" },
  { path: IMS_PATH.payments, label: "Payments & Receipts", hint: "Money in and money out" },
  {
    path: IMS_PATH.receivables,
    label: "Customer Receivables",
    hint: "Who owes the business money",
  },
  { path: IMS_PATH.payables, label: "Supplier Payables", hint: "Who the business owes" },
  { path: IMS_PATH.cash, label: "Bank & Cash", hint: "The money itself, account by account" },
  {
    path: IMS_PATH.financialReports,
    label: "Financial Reports",
    hint: "Trial balance, balance sheet, profit and loss",
  },
  {
    path: IMS_PATH.financeSettings,
    label: "Financial Settings",
    hint: "Periods, opening balances and the chart",
  },
];

/* -------------------------------------------------------------------------- */
/* wording                                                                     */
/* -------------------------------------------------------------------------- */

/** A short, plain explanation of an accounting term. */
export const ACCOUNTING_TERMS: Readonly<Record<string, string>> = {
  debit: "A debit is the left-hand side of an entry. Assets and expenses go up on the debit side.",
  credit:
    "A credit is the right-hand side of an entry. Liabilities, equity and income go up on the credit side.",
  receivable: "Money customers owe the business. It is an asset, because it will come back.",
  payable: "Money the business owes suppliers. It is a liability, because it will have to go out.",
  accrual: "Recording a sale when it happens, not when the money arrives.",
  cash: "Money in hand and money at the bank - the only accounts that move when money actually moves.",
  opening: "The balances the books start with on the first day of trading.",
  trialBalance: "A list of every account and its balance, used to prove that the books add up.",
  balanceSheet: "What the business owns and owes at one moment in time.",
  profitAndLoss: "What the business earned and what it cost, over a period of time.",
  cashFlow:
    "Where the cash came from and where it went. A credit sale earns money without moving any.",
  aging: "How late the unpaid invoices are, grouped into bands.",
  reconciliation: "Checking that a control account agrees with the list behind it.",
  contra: "An account that reduces another one, such as accumulated depreciation.",
};

/** The plain-language name for an account type. */
export const ACCOUNT_TYPE_LABELS: Readonly<Record<string, string>> = {
  asset: "Asset",
  liability: "Liability",
  equity: "Equity",
  income: "Income",
  expense: "Expense",
};

/** The plain-language name for an account sub-type. */
export const ACCOUNT_SUBTYPE_LABELS: Readonly<Record<string, string>> = {
  currentAsset: "Current asset",
  fixedAsset: "Fixed asset",
  contraAsset: "Contra asset",
  currentLiability: "Current liability",
  longTermLiability: "Long-term liability",
  equity: "Equity",
  operatingIncome: "Operating income",
  otherIncome: "Other income",
  cogs: "Cost of goods sold",
  operatingExpense: "Operating expense",
  otherExpense: "Other expense",
};

/** The wording for a journal source, as a person would say it. */
export const JOURNAL_SOURCE_LABELS: Readonly<Record<string, string>> = {
  purchase: "Purchase",
  sale: "Sale",
  payment: "Payment",
  expense: "Expense",
  manual: "Manual",
  transfer: "Transfer",
  opening: "Opening",
  reversal: "Reversal",
  adjustment: "Adjustment",
};
