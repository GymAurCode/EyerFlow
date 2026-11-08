/**
 * The Chart of Accounts, as a tree.
 *
 * An account may have a parent: a sub-account sits under the account it
 * belongs to. The chart is therefore a tree, and a tree that cannot be folded
 * up is just a long list.
 *
 * The logic lives here, away from the screen, because it is the part that is
 * easy to get wrong: an account whose parent is missing from the chart (it was
 * deleted, or it belongs to another book) must still appear rather than vanish,
 * and a search must never hide a match behind a collapsed branch.
 */

import type { AccountDto, AccountType } from "../../shared/finance";

/**
 * The five categories the chart is organised into, in the order they are shown.
 *
 * The order is the order of the balance sheet: what the business owns, what it
 * owes, what the owner put in, what it earned and what it cost. A reader who
 * has seen one statement knows where to look in the next.
 */
export const ACCOUNT_CATEGORY_ORDER: readonly AccountType[] = [
  "asset",
  "liability",
  "equity",
  "income",
  "expense",
];

/** The plural name of each category, as it appears in the tree. */
export const ACCOUNT_CATEGORY_LABELS: Readonly<Record<AccountType, string>> = {
  asset: "Assets",
  liability: "Liabilities",
  equity: "Equity",
  income: "Income",
  expense: "Expenses",
};

export interface AccountTreeNode {
  readonly account: AccountDto;
  /** How many levels down the tree this account sits. 0 for a root. */
  readonly depth: number;
  /** How many sub-accounts sit directly under this one. */
  readonly childCount: number;
}

/**
 * One category of the chart, with the accounts under it.
 */
export interface AccountCategoryTree {
  readonly type: AccountType;
  readonly label: string;
  /** The accounts of this category, flattened into tree order. */
  readonly rows: readonly AccountTreeNode[];
  /** How many accounts the category holds in all. */
  readonly accountCount: number;
  /**
   * The category's balances added together.
   *
   * This is an aggregate of the accounts in the category, not a balance of its
   * own: it is the sum over the category's *root* accounts, each of which
   * already carries its sub-accounts. Adding the parents and the children
   * separately would count the same money twice.
   */
  readonly totalBalanceFils: number;
}

export interface AccountTreeOptions {
  /**
   * The accounts whose branches are folded up. An account that is not in this
   * set - or that has no sub-accounts - is always open.
   */
  readonly collapsedIds?: ReadonlySet<number> | undefined;
  /**
   * When set, only these accounts are shown, and every branch is open.
   *
   * This is how a search behaves: a reader who searches for an account wants
   * to see it and the path that leads to it, whatever they had folded up
   * before.
   */
  readonly visibleIds?: ReadonlySet<number> | undefined;
  /** How siblings are ordered. Defaults to the account code. */
  readonly sortValue?:
    | ((account: AccountDto) => string | number | null | undefined)
    | undefined;
  readonly sortDirection?: "asc" | "desc" | undefined;
}

function compare(
  left: AccountDto,
  right: AccountDto,
  sortValue: (account: AccountDto) => string | number | null | undefined,
  direction: "asc" | "desc",
): number {
  const a = sortValue(left);
  const b = sortValue(right);

  // A missing value sorts last in both directions, so an empty cell never
  // jumps to the top of the list.
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : 1;
  if (b === null || b === undefined) return -1;

  let result: number;
  if (typeof a === "number" && typeof b === "number") {
    result = a - b;
  } else {
    result = String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
  }

  return direction === "desc" ? -result : result;
}

/**
 * Build the flat, ordered list of rows the table shows.
 *
 * The tree is flattened depth-first, so a sub-account appears directly under
 * its parent, and the parent carries the count of what is folded inside it.
 */
export function buildAccountTree(
  accounts: readonly AccountDto[],
  options: AccountTreeOptions = {},
): readonly AccountTreeNode[] {
  const collapsed = options.collapsedIds ?? new Set<number>();
  const visible = options.visibleIds;
  const sortValue = options.sortValue ?? ((account: AccountDto) => account.code);
  const direction = options.sortDirection ?? "asc";

  // Only the accounts that are actually shown take part in the tree.
  const present = visible === undefined ? accounts : accounts.filter((a) => visible.has(a.id));
  const byId = new Map(present.map((account) => [account.id, account] as const));

  const childrenOf = new Map<number, AccountDto[]>();
  const roots: AccountDto[] = [];

  for (const account of present) {
    const parentId = account.parentId;
    // An account whose parent is not in the chart is a root of its own: it is
    // shown at the top level rather than disappearing.
    if (parentId === null || parentId === undefined || !byId.has(parentId)) {
      roots.push(account);
      continue;
    }
    const siblings = childrenOf.get(parentId) ?? [];
    siblings.push(account);
    childrenOf.set(parentId, siblings);
  }

  for (const siblings of childrenOf.values()) {
    siblings.sort((a, b) => compare(a, b, sortValue, direction));
  }
  roots.sort((a, b) => compare(a, b, sortValue, direction));

  const nodes: AccountTreeNode[] = [];

  const visit = (account: AccountDto, depth: number): void => {
    const children = childrenOf.get(account.id) ?? [];
    nodes.push({ account, depth, childCount: children.length });

    // A search opens every branch: a match must never be hidden inside a
    // branch the reader had folded up.
    const isOpen = visible !== undefined || !collapsed.has(account.id);
    if (!isOpen) return;

    for (const child of children) {
      visit(child, depth + 1);
    }
  };

  for (const root of roots) {
    visit(root, 0);
  }

  return nodes;
}

/**
 * The accounts to keep when a filter is on: the matches, plus every account
 * on the path to them.
 *
 * Without the ancestors a match on a sub-account would appear with no
 * context - a bare line with no sign of which account it belongs to.
 */
export function closeOverAncestors(
  accounts: readonly AccountDto[],
  keepIds: ReadonlySet<number>,
): Set<number> {
  const byId = new Map(accounts.map((account) => [account.id, account] as const));
  const closed = new Set<number>();

  for (const id of keepIds) {
    let current = byId.get(id);
    // The walk is bounded by the number of accounts, so a cycle in the data
    // cannot spin here for ever.
    for (let guard = 0; guard <= accounts.length && current !== undefined; guard += 1) {
      if (closed.has(current.id)) break;
      closed.add(current.id);
      const parentId = current.parentId;
      current = parentId === null || parentId === undefined ? undefined : byId.get(parentId);
    }
  }

  return closed;
}

/**
 * The accounts that have sub-accounts under them.
 *
 * The "collapse all" control uses this so it never offers to fold up a chart
 * that has no hierarchy to fold.
 */
export function accountsWithChildren(
  accounts: readonly AccountDto[],
): ReadonlySet<number> {
  const ids = new Set(accounts.map((account) => account.id));
  const parents = new Set<number>();

  for (const account of accounts) {
    const parentId = account.parentId;
    if (parentId === null || parentId === undefined) continue;
    if (ids.has(parentId)) parents.add(parentId);
  }

  return parents;
}

/**
 * The balance of every account, with its sub-accounts added in.
 *
 * An account's own balance is only the postings made directly to it. A parent
 * that carries sub-accounts usually has none of its own, so the two figures
 * are the same - but they are not the same *meaning*, and a reader looking at a
 * parent needs to know which one they are being shown.
 *
 * The map is keyed by account id and holds the aggregate: the account's own
 * balance plus the aggregate of each of its children.
 */
export function aggregatedBalances(
  accounts: readonly AccountDto[],
): ReadonlyMap<number, number> {
  const byId = new Map(accounts.map((account) => [account.id, account] as const));

  const childrenOf = new Map<number, number[]>();
  for (const account of accounts) {
    const parentId = account.parentId;
    // A parent that is not in the chart is not a parent of anything: the
    // account stands on its own, as the tree shows it.
    if (parentId === null || parentId === undefined || !byId.has(parentId)) continue;
    const siblings = childrenOf.get(parentId) ?? [];
    siblings.push(account.id);
    childrenOf.set(parentId, siblings);
  }

  const totals = new Map<number, number>();
  const walking = new Set<number>();

  const total = (id: number): number => {
    const cached = totals.get(id);
    if (cached !== undefined) return cached;
    // A cycle cannot be written through the account editor, but a database
    // edited by hand could hold one. Stopping here keeps this a walk rather
    // than a spin.
    if (walking.has(id)) return 0;
    walking.add(id);

    let sum = byId.get(id)?.balanceFils ?? 0;
    for (const childId of childrenOf.get(id) ?? []) {
      sum += total(childId);
    }

    walking.delete(id);
    totals.set(id, sum);
    return sum;
  };

  for (const account of accounts) {
    total(account.id);
  }

  return totals;
}

/**
 * A node of the tree with the branch under it.
 *
 * `buildAccountTree` returns the tree flattened, because that is what a table
 * wants. A tree *view* wants the nesting back, and this puts it back without
 * touching the flattened helper the table and its tests rely on.
 */
export interface AccountBranchNode {
  readonly account: AccountDto;
  readonly depth: number;
  readonly childCount: number;
  readonly children: AccountBranchNode[];
}

/**
 * Rebuild the branches of a flattened tree.
 *
 * The flattened rows are in depth-first order with their depth, so the parent
 * of a row is the nearest row before it that sits one level higher.
 */
export function buildBranches(
  rows: readonly AccountTreeNode[],
): readonly AccountBranchNode[] {
  const roots: AccountBranchNode[] = [];
  const stack: AccountBranchNode[] = [];

  for (const row of rows) {
    const node: AccountBranchNode = {
      account: row.account,
      depth: row.depth,
      childCount: row.childCount,
      children: [],
    };

    // Anything at this depth or deeper cannot be the parent of this row.
    while (stack.length > 0 && (stack[stack.length - 1]?.depth ?? -1) >= row.depth) {
      stack.pop();
    }

    const parent = stack[stack.length - 1];
    if (parent === undefined) {
      roots.push(node);
    } else {
      parent.children.push(node);
    }

    stack.push(node);
  }

  return roots;
}

/**
 * The chart as five categories, each with its accounts in tree order.
 *
 * The hierarchy inside a category is the account hierarchy: a sub-account sits
 * under the account it belongs to, and an account whose parent is missing from
 * the chart is shown at the top of its category rather than lost.
 */
export function buildCategoryTrees(
  accounts: readonly AccountDto[],
  options: AccountTreeOptions = {},
): readonly AccountCategoryTree[] {
  const aggregated = aggregatedBalances(accounts);
  const knownIds = new Set(accounts.map((account) => account.id));

  const byCategory = new Map<AccountType, AccountDto[]>();
  for (const account of accounts) {
    const list = byCategory.get(account.type) ?? [];
    list.push(account);
    byCategory.set(account.type, list);
  }

  return ACCOUNT_CATEGORY_ORDER.map((type) => {
    const list = byCategory.get(type) ?? [];
    const rows = buildAccountTree(list, options);

    // The category total is the sum over its root accounts, each of which
    // already carries its own sub-accounts. Summing every row instead would
    // count a parent and its children twice.
    //
    // It is worked out over the whole category rather than over the rows on
    // screen, so a search narrows the list without quietly changing what the
    // category adds up to.
    const totalBalanceFils = list
      .filter(
        (account) =>
          account.parentId === null ||
          account.parentId === undefined ||
          !knownIds.has(account.parentId),
      )
      .reduce((sum, account) => sum + (aggregated.get(account.id) ?? account.balanceFils), 0);

    return {
      type,
      label: ACCOUNT_CATEGORY_LABELS[type],
      rows,
      accountCount: list.length,
      totalBalanceFils,
    };
  });
}
