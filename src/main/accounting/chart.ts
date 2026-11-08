/**
 * The Chart of Accounts.
 *
 * Accounts are addressed by a stable `code` rather than by row id, because the
 * postings, the reports and any future migration all need to name "Cash in
 * Hand" or "Accounts Payable" without knowing which row that is in a given
 * database. Codes are the contract; ids are an implementation detail.
 *
 * Seeding is idempotent. It runs on every start and after the migration, and it
 * only ever inserts a code that is missing, so re-running it cannot duplicate an
 * account or overwrite a name the shop has edited.
 */

import type { SqliteDatabase } from "../../data/connection";

export type AccountType = "asset" | "liability" | "equity" | "income" | "expense";

export type AccountSubtype =
  | "currentAsset"
  | "fixedAsset"
  | "contraAsset"
  | "currentLiability"
  | "longTermLiability"
  | "equity"
  | "operatingIncome"
  | "otherIncome"
  | "cogs"
  | "operatingExpense"
  | "otherExpense";

/**
 * The codes the accounting service posts against.
 *
 * Kept as a frozen object rather than as loose strings so a typo is a compile
 * error, and so there is exactly one place that knows which account a posting
 * means.
 */
export const SYSTEM_ACCOUNTS = {
  cashInHand: "1000",
  bank: "1010",
  accountsReceivable: "1020",
  inventory: "1030",
  prepaidExpenses: "1040",
  equipment: "1500",
  accumulatedDepreciation: "1590",

  accountsPayable: "2000",
  supplierAdvances: "2010",
  customerAdvances: "2020",
  taxPayable: "2030",
  otherCurrentLiabilities: "2040",
  longTermLiabilities: "2500",

  capital: "3000",
  drawings: "3010",
  retainedEarnings: "3020",
  currentPeriodEarnings: "3030",

  salesRevenue: "4000",
  salesReturns: "4010",
  otherOperatingIncome: "4020",
  otherIncome: "4030",

  costOfGoodsSold: "5000",
  salaries: "6000",
  rent: "6010",
  utilities: "6020",
  transport: "6030",
  marketing: "6040",
  repairs: "6050",
  officeSupplies: "6060",
  bankCharges: "6070",
  depreciation: "6080",
  miscellaneous: "6090",
  otherOperatingExpenses: "6100",
} as const;

export type SystemAccountCode = (typeof SYSTEM_ACCOUNTS)[keyof typeof SYSTEM_ACCOUNTS];

export interface AccountSeed {
  readonly code: string;
  readonly name: string;
  readonly type: AccountType;
  readonly subtype: AccountSubtype;
  readonly normalBalance: "debit" | "credit";
  readonly description?: string;
}

/**
 * The default chart.
 *
 * Normal balances follow the accounting rule rather than the code: assets and
 * expenses increase on the debit side, liabilities, equity and income on the
 * credit side. Accumulated depreciation is the one deliberate exception here -
 * it is a contra-asset, so it carries a credit balance inside the asset class,
 * and `normal_balance` is stored per account precisely so that this does not
 * need a special case in the reporting code.
 */
export const DEFAULT_CHART: readonly AccountSeed[] = [
  // --- Assets -------------------------------------------------------------
  { code: SYSTEM_ACCOUNTS.cashInHand, name: "Cash in Hand", type: "asset", subtype: "currentAsset", normalBalance: "debit", description: "Money physically held in the shop." },
  { code: SYSTEM_ACCOUNTS.bank, name: "Bank Account", type: "asset", subtype: "currentAsset", normalBalance: "debit", description: "Money held at the bank." },
  { code: SYSTEM_ACCOUNTS.accountsReceivable, name: "Accounts Receivable", type: "asset", subtype: "currentAsset", normalBalance: "debit", description: "Money customers owe. The control account for the customer subledger." },
  { code: SYSTEM_ACCOUNTS.inventory, name: "Inventory Asset", type: "asset", subtype: "currentAsset", normalBalance: "debit", description: "Stock on hand at cost." },
  { code: SYSTEM_ACCOUNTS.prepaidExpenses, name: "Prepaid Expenses", type: "asset", subtype: "currentAsset", normalBalance: "debit", description: "Paid for but not yet used." },
  { code: SYSTEM_ACCOUNTS.equipment, name: "Equipment & Fixed Assets", type: "asset", subtype: "fixedAsset", normalBalance: "debit", description: "Tools, vehicles and fittings." },
  { code: SYSTEM_ACCOUNTS.accumulatedDepreciation, name: "Accumulated Depreciation", type: "asset", subtype: "contraAsset", normalBalance: "credit", description: "Depreciation charged to date. Shown as a deduction from fixed assets." },

  // --- Liabilities --------------------------------------------------------
  { code: SYSTEM_ACCOUNTS.accountsPayable, name: "Accounts Payable", type: "liability", subtype: "currentLiability", normalBalance: "credit", description: "Money owed to suppliers. The control account for the supplier subledger." },
  { code: SYSTEM_ACCOUNTS.supplierAdvances, name: "Supplier Advances / Deposits", type: "liability", subtype: "currentLiability", normalBalance: "credit", description: "Paid to suppliers before we have bought from them." },
  { code: SYSTEM_ACCOUNTS.customerAdvances, name: "Customer Advances", type: "liability", subtype: "currentLiability", normalBalance: "credit", description: "Taken from customers before we have supplied them." },
  { code: SYSTEM_ACCOUNTS.taxPayable, name: "Tax Payable", type: "liability", subtype: "currentLiability", normalBalance: "credit", description: "Tax collected on sales and not yet remitted." },
  { code: SYSTEM_ACCOUNTS.otherCurrentLiabilities, name: "Other Current Liabilities", type: "liability", subtype: "currentLiability", normalBalance: "credit", description: "Anything else owed within the year." },
  { code: SYSTEM_ACCOUNTS.longTermLiabilities, name: "Long-Term Liabilities", type: "liability", subtype: "longTermLiability", normalBalance: "credit", description: "Loans and other long-term borrowing." },

  // --- Equity -------------------------------------------------------------
  { code: SYSTEM_ACCOUNTS.capital, name: "Owner's Capital", type: "equity", subtype: "equity", normalBalance: "credit", description: "What the owner put into the business." },
  { code: SYSTEM_ACCOUNTS.drawings, name: "Owner's Drawings", type: "equity", subtype: "equity", normalBalance: "debit", description: "Money taken out by the owner. Reduces equity." },
  { code: SYSTEM_ACCOUNTS.retainedEarnings, name: "Retained Earnings", type: "equity", subtype: "equity", normalBalance: "credit", description: "Profit kept from earlier closed periods." },
  { code: SYSTEM_ACCOUNTS.currentPeriodEarnings, name: "Current Period Earnings", type: "equity", subtype: "equity", normalBalance: "credit", description: "Profit for the period being reported. Balances the sheet; never posted to directly." },

  // --- Income -------------------------------------------------------------
  { code: SYSTEM_ACCOUNTS.salesRevenue, name: "Sales Revenue", type: "income", subtype: "operatingIncome", normalBalance: "credit", description: "What goods and services were sold for." },
  { code: SYSTEM_ACCOUNTS.salesReturns, name: "Sales Returns & Allowances", type: "income", subtype: "operatingIncome", normalBalance: "debit", description: "Goods returned by customers. Reduces revenue." },
  { code: SYSTEM_ACCOUNTS.otherOperatingIncome, name: "Other Operating Income", type: "income", subtype: "operatingIncome", normalBalance: "credit", description: "Income that comes from running the business." },
  { code: SYSTEM_ACCOUNTS.otherIncome, name: "Other Income", type: "income", subtype: "otherIncome", normalBalance: "credit", description: "Income that is not part of trading." },

  // --- Expenses and costs -------------------------------------------------
  { code: SYSTEM_ACCOUNTS.costOfGoodsSold, name: "Cost of Goods Sold", type: "expense", subtype: "cogs", normalBalance: "debit", description: "What the goods sold actually cost." },
  { code: SYSTEM_ACCOUNTS.salaries, name: "Salaries & Wages", type: "expense", subtype: "operatingExpense", normalBalance: "debit" },
  { code: SYSTEM_ACCOUNTS.rent, name: "Rent Expense", type: "expense", subtype: "operatingExpense", normalBalance: "debit" },
  { code: SYSTEM_ACCOUNTS.utilities, name: "Utilities Expense", type: "expense", subtype: "operatingExpense", normalBalance: "debit" },
  { code: SYSTEM_ACCOUNTS.transport, name: "Transport & Delivery", type: "expense", subtype: "operatingExpense", normalBalance: "debit" },
  { code: SYSTEM_ACCOUNTS.marketing, name: "Marketing & Advertising", type: "expense", subtype: "operatingExpense", normalBalance: "debit" },
  { code: SYSTEM_ACCOUNTS.repairs, name: "Repairs & Maintenance", type: "expense", subtype: "operatingExpense", normalBalance: "debit" },
  { code: SYSTEM_ACCOUNTS.officeSupplies, name: "Office Supplies", type: "expense", subtype: "operatingExpense", normalBalance: "debit" },
  { code: SYSTEM_ACCOUNTS.bankCharges, name: "Bank Charges", type: "expense", subtype: "operatingExpense", normalBalance: "debit" },
  { code: SYSTEM_ACCOUNTS.depreciation, name: "Depreciation Expense", type: "expense", subtype: "operatingExpense", normalBalance: "debit" },
  { code: SYSTEM_ACCOUNTS.miscellaneous, name: "Miscellaneous Expense", type: "expense", subtype: "otherExpense", normalBalance: "debit" },
  { code: SYSTEM_ACCOUNTS.otherOperatingExpenses, name: "Other Operating Expenses", type: "expense", subtype: "operatingExpense", normalBalance: "debit" },
];

/**
 * Insert any account whose code is not already present.
 *
 * Deliberately insert-only: an existing row is left exactly as it is, including
 * a name the shop has changed and an `is_active` flag they have cleared. That
 * makes this safe to call on every start.
 */
export function seedChartOfAccounts(db: SqliteDatabase, nowIso: string): number {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO accounts
       (code, name, type, subtype, normal_balance, is_system, is_active, description,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?, ?)`,
  );

  let added = 0;
  db.transaction(() => {
    for (const account of DEFAULT_CHART) {
      const info = insert.run(
        account.code,
        account.name,
        account.type,
        account.subtype,
        account.normalBalance,
        account.description ?? null,
        nowIso,
        nowIso,
      );
      if (info.changes > 0) added += 1;
    }
  })();

  return added;
}

/** Row id for an account code, or null when the code is not in the chart. */
export function accountIdByCode(db: SqliteDatabase, code: string): number | null {
  const row = db.prepare("SELECT id FROM accounts WHERE code = ?").get(code) as
    | { id: number }
    | undefined;
  return row?.id ?? null;
}

/** Several codes at once, as a code -> id map. Throws if any code is missing. */
export function accountIdsByCode(
  db: SqliteDatabase,
  codes: readonly string[],
): ReadonlyMap<string, number> {
  const map = new Map<string, number>();
  for (const code of codes) {
    const id = accountIdByCode(db, code);
    if (id === null) {
      throw new Error(
        `Account ${code} is missing from the Chart of Accounts. The chart could not be seeded.`,
      );
    }
    map.set(code, id);
  }
  return map;
}
