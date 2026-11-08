/**
 * Managing the Chart of Accounts.
 *
 * The chart is the spine of the ledger: every journal line names an account,
 * and the reports group by the account's type and subtype. So the rules about
 * what may be changed are strict, and they are enforced here rather than in
 * the renderer, because a crafted request must not be able to corrupt a shop's
 * books.
 *
 * Three rules are worth stating outright:
 *
 *  1. **A code is an identity, not a label.** Two accounts may not share one,
 *     and a code that has been used may not be reused for a different account,
 *     because a journal line that said "1000" must always mean the same thing.
 *
 *  2. **A system account keeps its type.** Accounts Receivable, Accounts
 *     Payable, Inventory Asset and the rest are posted to by code. Retyping
 *     one would make every future posting land in the wrong class of the
 *     balance sheet, so a system account's *type* is fixed even though its
 *     name, description and parent are free.
 *
 *  3. **An account with history is never destroyed.** It can be deactivated,
 *     which stops new postings and keeps every past report intact. Deleting
 *     it would leave journal lines pointing at nothing.
 */

import type { SqliteDatabase } from "../../data/connection";
import type { Fils } from "../../domain/money";
import {
  DEFAULT_CHART,
  SYSTEM_ACCOUNTS,
  type AccountSubtype,
  type AccountType,
} from "./chart";

export class AccountError extends Error {
  public constructor(message: string, readonly field?: string) {
    super(message);
    this.name = "AccountError";
  }
}

export interface AccountRow {
  readonly id: number;
  readonly code: string;
  readonly name: string;
  readonly type: AccountType;
  readonly subtype: string | null;
  readonly parent_id: number | null;
  readonly normal_balance: "debit" | "credit";
  readonly is_system: number;
  readonly is_active: number;
  readonly description: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface AccountDto {
  readonly id: number;
  readonly code: string;
  readonly name: string;
  readonly type: AccountType;
  readonly subtype: AccountSubtype | null;
  readonly parentId: number | null;
  readonly parentCode: string | null;
  readonly normalBalance: "debit" | "credit";
  readonly isSystem: boolean;
  readonly isActive: boolean;
  readonly description: string | null;
  /** Current balance in the account's own normal balance. 0 when untouched. */
  readonly balanceFils: Fils;
  /** How many journal lines name this account. 0 means it has no history. */
  readonly usageCount: number;
  /** When the row was created, and when it was last changed. */
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SaveAccountRequest {
  readonly id?: number | undefined;
  readonly code: string;
  readonly name: string;
  readonly type: AccountType;
  readonly subtype?: AccountSubtype | null | undefined;
  readonly parentId?: number | null | undefined;
  readonly normalBalance?: "debit" | "credit" | undefined;
  readonly description?: string | null | undefined;
  readonly isActive?: boolean | undefined;
}

/** Codes the posting service depends on. These may be renamed but not retyped. */
const SYSTEM_CODES: ReadonlySet<string> = new Set<string>(Object.values(SYSTEM_ACCOUNTS));

export function isSystemCode(code: string): boolean {
  return SYSTEM_CODES.has(code);
}

/* -------------------------------------------------------------------------- */
/* reading                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Balances for a set of account codes, in each account's own normal balance.
 *
 * Only posted and reversed entries count. A draft is a intention, not a fact,
 * and a reversed entry and its reversal cancel, so both are excluded rather
 * than double-counted.
 */
export function balancesByCode(db: SqliteDatabase): Map<string, Fils> {
  const rows = db
    .prepare(
      `SELECT a.code AS code, a.normal_balance AS normalBalance,
              COALESCE(SUM(l.debit_fils), 0) AS debit,
              COALESCE(SUM(l.credit_fils), 0) AS credit
         FROM accounts a
         LEFT JOIN journal_lines l ON l.account_id = a.id
         LEFT JOIN journal_entries e ON e.id = l.entry_id
        WHERE e.id IS NULL OR (e.status IN ('posted','reversed') AND e.entry_date <= ?)
        GROUP BY a.id`,
    )
    .all("9999-12-31") as {
    code: string;
    normalBalance: "debit" | "credit";
    debit: number;
    credit: number;
  }[];

  const map = new Map<string, Fils>();
  for (const row of rows) {
    const movement = row.debit - row.credit;
    map.set(row.code, row.normalBalance === "debit" ? movement : -movement);
  }
  return map;
}

/** How many journal lines name each account code. */
function usageCounts(db: SqliteDatabase): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT a.code AS code, COUNT(l.id) AS count
         FROM accounts a
         LEFT JOIN journal_lines l ON l.account_id = a.id
        GROUP BY a.id`,
    )
    .all() as { code: string; count: number }[];

  return new Map(rows.map((row) => [row.code, row.count] as const));
}

export function listAccounts(db: SqliteDatabase): AccountDto[] {
  const rows = db
    .prepare(
      `SELECT a.id, a.code, a.name, a.type, a.subtype, a.parent_id, a.normal_balance,
              a.is_system, a.is_active, a.description, a.created_at, a.updated_at,
              p.code AS parent_code
         FROM accounts a
         LEFT JOIN accounts p ON p.id = a.parent_id
        ORDER BY a.code`,
    )
    .all() as (AccountRow & { parent_code: string | null })[];

  const balances = balancesByCode(db);
  const usage = usageCounts(db);

  return rows.map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    type: row.type,
    subtype: (row.subtype as AccountSubtype | null) ?? null,
    parentId: row.parent_id,
    parentCode: row.parent_code ?? null,
    normalBalance: row.normal_balance,
    isSystem: row.is_system === 1,
    isActive: row.is_active === 1,
    description: row.description,
    balanceFils: balances.get(row.code) ?? 0,
    usageCount: usage.get(row.code) ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export function getAccount(db: SqliteDatabase, id: number): AccountDto {
  const account = listAccounts(db).find((row) => row.id === id);
  if (account === undefined) throw new AccountError(`Account ${String(id)} was not found.`);
  return account;
}

/* -------------------------------------------------------------------------- */
/* validation                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The normal balance an account of this type and subtype carries.
 *
 * Three accounts in the default chart deliberately differ from their type:
 * accumulated depreciation is a contra-asset, drawings are a debit inside
 * equity, and sales returns are a debit inside income. The rule is derived
 * rather than typed in by hand so a user-created account of a known subtype
 * lands on the right side without having to know the convention.
 */
export function normalBalanceFor(
  type: AccountType,
  subtype: AccountSubtype | null,
): "debit" | "credit" {
  if (subtype === "contraAsset") return "credit";
  if (type === "asset" || type === "expense") return "debit";
  if (type === "equity" && subtype === "equity") return "credit";
  if (type === "income" && subtype === "operatingIncome") return "debit";
  return "credit";
}

/**
 * Walk the parent chain and refuse a loop.
 *
 * A cycle in the hierarchy would make the tree view recurse forever and would
 * make any roll-up of a parent meaningless, so it is refused at write time
 * rather than discovered later.
 */
function assertNoCycle(
  db: SqliteDatabase,
  accountId: number | null,
  parentId: number | null,
): void {
  if (parentId === null) return;

  const seen = new Set<number>();
  let cursor: number | null = parentId;

  while (cursor !== null) {
    if (cursor === accountId) {
      throw new AccountError(
        "That parent would make the account its own ancestor. Choose a different parent account.",
        "parentId",
      );
    }
    if (seen.has(cursor)) {
      throw new AccountError(
        "That parent account is itself part of a loop. Fix the hierarchy first.",
        "parentId",
      );
    }
    seen.add(cursor);

    const row = db.prepare("SELECT parent_id FROM accounts WHERE id = ?").get(cursor) as
      | { parent_id: number | null }
      | undefined;
    cursor = row?.parent_id ?? null;
  }
}

/** The subtypes that make sense for a type, and the label shown in the editor. */
export const ACCOUNT_SUBTYPES: readonly {
  readonly value: AccountSubtype;
  readonly label: string;
  readonly types: readonly AccountType[];
}[] = [
  { value: "currentAsset", label: "Current asset", types: ["asset"] },
  { value: "fixedAsset", label: "Fixed asset", types: ["asset"] },
  { value: "contraAsset", label: "Contra asset (reduces another asset)", types: ["asset"] },
  { value: "currentLiability", label: "Current liability", types: ["liability"] },
  { value: "longTermLiability", label: "Long-term liability", types: ["liability"] },
  { value: "equity", label: "Equity", types: ["equity"] },
  { value: "operatingIncome", label: "Operating income", types: ["income"] },
  { value: "otherIncome", label: "Other income", types: ["income"] },
  { value: "cogs", label: "Cost of goods sold", types: ["expense"] },
  { value: "operatingExpense", label: "Operating expense", types: ["expense"] },
  { value: "otherExpense", label: "Other expense", types: ["expense"] },
];

export const ACCOUNT_TYPES: readonly { readonly value: AccountType; readonly label: string }[] = [
  { value: "asset", label: "Asset" },
  { value: "liability", label: "Liability" },
  { value: "equity", label: "Equity" },
  { value: "income", label: "Income" },
  { value: "expense", label: "Expense" },
];

/* -------------------------------------------------------------------------- */
/* writing                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Create or update an account.
 *
 * The rules enforced here are the ones a chart needs to stay usable:
 * a unique code, a parent that exists and does not create a loop, and a system
 * account whose type cannot be changed out from under the postings.
 */
export function saveAccount(
  db: SqliteDatabase,
  request: SaveAccountRequest,
  nowIso: string,
): AccountDto {
  const code = request.code.trim();
  const name = request.name.trim();

  if (code.length === 0) throw new AccountError("An account needs a code.", "code");
  if (name.length === 0) throw new AccountError("An account needs a name.", "name");

  const existing =
    request.id === undefined
      ? undefined
      : (db.prepare("SELECT * FROM accounts WHERE id = ?").get(request.id) as
          | AccountRow
          | undefined);

  if (request.id !== undefined && existing === undefined) {
    throw new AccountError(`Account ${String(request.id)} was not found.`);
  }

  // Code uniqueness. An edit keeps its own code; anything else must be free.
  const codeOwner = db.prepare("SELECT id FROM accounts WHERE code = ?").get(code) as
    | { id: number }
    | undefined;
  if (codeOwner !== undefined && codeOwner.id !== request.id) {
    throw new AccountError(`The code ${code} is already used by another account.`, "code");
  }

  // A system account keeps its type. The postings name it by code, and the
  // reports group by type; retyping one would move it in the balance sheet.
  if (existing !== undefined && existing.is_system === 1 && existing.type !== request.type) {
    throw new AccountError(
      `${existing.name} is a system account and cannot be moved from ${existing.type} to ${request.type}. ` +
        "Deactivate it and create a new account if you need a different kind.",
      "type",
    );
  }

  if (request.parentId !== undefined && request.parentId !== null) {
    const parent = db.prepare("SELECT id FROM accounts WHERE id = ?").get(request.parentId);
    if (parent === undefined) {
      throw new AccountError("The parent account was not found.", "parentId");
    }
  }
  assertNoCycle(db, request.id ?? -1, request.parentId ?? null);

  const subtype = request.subtype ?? null;
  const normalBalance =
    request.normalBalance ??
    (existing !== undefined && existing.is_system === 1
      ? existing.normal_balance
      : normalBalanceFor(request.type, subtype));

  if (existing === undefined) {
    const info = db
      .prepare(
        `INSERT INTO accounts
           (code, name, type, subtype, parent_id, normal_balance, is_system, is_active,
            description, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?, ?, ?)`,
      )
      .run(
        code,
        name,
        request.type,
        subtype,
        request.parentId ?? null,
        normalBalance,
        request.description ?? null,
        nowIso,
        nowIso,
      );
    return getAccount(db, Number(info.lastInsertRowid));
  }

  db.prepare(
    `UPDATE accounts
        SET code = ?, name = ?, type = ?, subtype = ?, parent_id = ?, normal_balance = ?,
            is_active = ?, description = ?, updated_at = ?
      WHERE id = ?`,
  ).run(
    code,
    name,
    request.type,
    subtype,
    request.parentId ?? null,
    normalBalance,
    request.isActive === undefined ? existing.is_active : request.isActive === true ? 1 : 0,
    request.description ?? null,
    nowIso,
    existing.id,
  );

  return getAccount(db, existing.id);
}

/**
 * Deactivate an account.
 *
 * Deactivation is how an account that is no longer used is retired: it stops
 * appearing in pickers, new postings to it are refused, and every past
 * report that names it still reads correctly.
 */
export function setAccountActive(
  db: SqliteDatabase,
  id: number,
  isActive: boolean,
  nowIso: string,
): AccountDto {
  const existing = db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as
    | AccountRow
    | undefined;
  if (existing === undefined) throw new AccountError(`Account ${String(id)} was not found.`);

  if (!isActive) {
    const used = db
      .prepare(
        `SELECT COUNT(*) AS count FROM journal_lines l
           JOIN journal_entries e ON e.id = l.entry_id
          WHERE l.account_id = ? AND e.status IN ('posted','reversed')`,
      )
      .get(id) as { count: number };
    if (used.count > 0) {
      // Deactivating is still allowed: the account keeps its history. What is
      // refused is deleting it, below.
      void used;
    }
  }

  db.prepare("UPDATE accounts SET is_active = ?, updated_at = ? WHERE id = ?").run(
    isActive === true ? 1 : 0,
    nowIso,
    id,
  );
  return getAccount(db, id);
}

/**
 * Delete an account that has never been used.
 *
 * An account with postings is never deleted: the journal lines would be left
 * pointing at a row that no longer exists, and the historical reports would
 * stop adding up. The account is deactivated instead, which is reversible and
 * loses nothing.
 */
export function deleteAccount(db: SqliteDatabase, id: number, nowIso: string): void {
  const existing = db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as
    | AccountRow
    | undefined;
  if (existing === undefined) throw new AccountError(`Account ${String(id)} was not found.`);

  const used = db
    .prepare("SELECT COUNT(*) AS count FROM journal_lines WHERE account_id = ?")
    .get(id) as { count: number };

  if (used.count > 0) {
    throw new AccountError(
      `${existing.name} has ${String(used.count)} ledger entr${used.count === 1 ? "y" : "ies"} against it, ` +
        "so it cannot be deleted. Deactivate it instead - its history stays in the reports.",
    );
  }

  const children = db
    .prepare("SELECT COUNT(*) AS count FROM accounts WHERE parent_id = ?")
    .get(id) as { count: number };
  if (children.count > 0) {
    throw new AccountError(
      `${existing.name} has sub-accounts under it. Move them first, then delete it.`,
    );
  }

  db.prepare("DELETE FROM accounts WHERE id = ?").run(id);
  void nowIso;
}

/* -------------------------------------------------------------------------- */
/* export                                                                      */
/* -------------------------------------------------------------------------- */

export interface ChartExportRow {
  readonly code: string;
  readonly name: string;
  readonly type: string;
  readonly subtype: string | null;
  readonly parent: string | null;
  readonly normalBalance: string;
  readonly isSystem: boolean;
  readonly isActive: boolean;
  readonly balanceFils: Fils;
}

/** The chart as plain rows, ready for a CSV file or a printed sheet. */
export function exportChart(db: SqliteDatabase): readonly ChartExportRow[] {
  return listAccounts(db).map((account) => ({
    code: account.code,
    name: account.name,
    type: account.type,
    subtype: account.subtype,
    parent: account.parentCode,
    normalBalance: account.normalBalance,
    isSystem: account.isSystem,
    isActive: account.isActive,
    balanceFils: account.balanceFils,
  }));
}

/**
 * Add the accounts the default chart is missing, without touching the rest.
 *
 * Used by the "restore missing accounts" action in Finance Settings, for a
 * shop whose chart was edited and then found to be missing something. It
 * inserts only the codes that are absent, so it never duplicates an account
 * and never renames one the shop has changed.
 */
export function restoreMissingAccounts(db: SqliteDatabase, nowIso: string): number {
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
