import { describe, expect, it } from "vitest";
import {
  accountsWithChildren,
  aggregatedBalances,
  buildBranches,
  buildAccountTree,
  buildCategoryTrees,
  closeOverAncestors,
} from "../src/renderer/lib/account-tree";
import type { AccountDto } from "../src/shared/finance";

/**
 * The Chart of Accounts as a tree.
 *
 * The chart is the spine of the Finance module, and a shopkeeper folds it up
 * for the same reason they fold up a filing cabinet: to see the shape of it
 * rather than every line of it. These tests are about the folding - what a
 * collapsed branch shows, what a search shows, and what happens to an account
 * whose parent is not there any more.
 */

let nextId = 1;

function account(over: Partial<AccountDto> & { readonly code: string }): AccountDto {
  const id = over.id ?? nextId++;
  return {
    id,
    code: over.code,
    name: over.name ?? `Account ${over.code}`,
    type: over.type ?? "asset",
    subtype: over.subtype ?? "currentAsset",
    parentId: over.parentId ?? null,
    parentCode: over.parentCode ?? null,
    normalBalance: over.normalBalance ?? "debit",
    isSystem: over.isSystem ?? false,
    isActive: over.isActive ?? true,
    description: over.description ?? null,
    balanceFils: over.balanceFils ?? 0,
    usageCount: over.usageCount ?? 0,
    createdAt: over.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: over.updatedAt ?? "2026-01-01T00:00:00.000Z",
  };
}

describe("the chart of accounts as a tree", () => {
  it("shows a flat chart as a flat list, in code order", () => {
    nextId = 1;
    const accounts = [account({ code: "3000" }), account({ code: "1000" }), account({ code: "2000" })];

    const rows = buildAccountTree(accounts);

    expect(rows.map((row) => row.account.code)).toEqual(["1000", "2000", "3000"]);
    expect(rows.every((row) => row.depth === 0)).toBe(true);
    expect(rows.every((row) => row.childCount === 0)).toBe(true);
  });

  it("places a sub-account directly under its parent", () => {
    nextId = 1;
    const parent = account({ id: 1, code: "1000", name: "Cash and Bank" });
    const child = account({ id: 2, code: "1010", name: "Bank Account", parentId: 1 });
    const other = account({ id: 3, code: "2000" });

    const rows = buildAccountTree([parent, child, other]);

    expect(rows.map((row) => [row.account.code, row.depth])).toEqual([
      ["1000", 0],
      ["1010", 1],
      ["2000", 0],
    ]);
    // The parent knows how many sub-accounts are folded inside it.
    expect(rows[0]?.childCount).toBe(1);
    expect(rows[1]?.childCount).toBe(0);
  });

  it("folds a branch up without losing the parent", () => {
    nextId = 1;
    const parent = account({ id: 1, code: "1000" });
    const child = account({ id: 2, code: "1010", parentId: 1 });

    const collapsed = buildAccountTree([parent, child], {
      collapsedIds: new Set([1]),
    });

    expect(collapsed.map((row) => row.account.code)).toEqual(["1000"]);
    // The parent still says how much is inside it, so the reader knows there
    // is something to open.
    expect(collapsed[0]?.childCount).toBe(1);
  });

  it("opens every branch when a filter is on, so a match is never hidden", () => {
    nextId = 1;
    const parent = account({ id: 1, code: "1000" });
    const child = account({ id: 2, code: "1010", parentId: 1 });

    // The reader had folded the branch up, then searched for the sub-account.
    const rows = buildAccountTree([parent, child], {
      collapsedIds: new Set([1]),
      visibleIds: new Set([1, 2]),
    });

    expect(rows.map((row) => row.account.code)).toEqual(["1000", "1010"]);
  });

  it("keeps the accounts that lead to a match, so it has a context", () => {
    nextId = 1;
    const grandparent = account({ id: 1, code: "1000" });
    const parent = account({ id: 2, code: "1010", parentId: 1 });
    const child = account({ id: 3, code: "1020", parentId: 2 });
    const accounts = [grandparent, parent, child];

    const closed = closeOverAncestors(accounts, new Set([3]));

    expect([...closed].sort()).toEqual([1, 2, 3]);
    // An account that is not a match and not an ancestor is left out.
    expect(closed.has(99)).toBe(false);
  });

  it("shows an account whose parent is missing, rather than losing it", () => {
    nextId = 1;
    const orphan = account({ id: 5, code: "1230", parentId: 999 });

    const rows = buildAccountTree([orphan]);

    expect(rows.map((row) => row.account.code)).toEqual(["1230"]);
    expect(rows[0]?.depth).toBe(0);
  });

  it("sorts within a level, so a sub-account stays under its parent", () => {
    nextId = 1;
    const parent = account({ id: 1, code: "1000", name: "Parent" });
    const zebra = account({ id: 2, code: "1010", name: "Zebra", parentId: 1 });
    const alpha = account({ id: 3, code: "1020", name: "Alpha", parentId: 1 });
    const root = account({ id: 4, code: "2000", name: "Root" });

    const rows = buildAccountTree([parent, zebra, alpha, root], {
      sortValue: (account) => account.name,
    });

    expect(rows.map((row) => row.account.name)).toEqual([
      "Parent",
      "Alpha",
      "Zebra",
      "Root",
    ]);
    expect(rows.map((row) => row.depth)).toEqual([0, 1, 1, 0]);
  });

  it("knows which accounts have sub-accounts", () => {
    nextId = 1;
    const parent = account({ id: 1, code: "1000" });
    const child = account({ id: 2, code: "1010", parentId: 1 });
    const lonely = account({ id: 3, code: "2000" });

    const parents = accountsWithChildren([parent, child, lonely]);

    expect([...parents]).toEqual([1]);
  });

  it("does not fold a branch that does not exist", () => {
    nextId = 1;
    const accounts = [account({ code: "1000" }), account({ code: "2000" })];

    expect(accountsWithChildren(accounts).size).toBe(0);

    // And building the tree is still correct with a collapsed set that names
    // an account with no children.
    const rows = buildAccountTree(accounts, { collapsedIds: new Set([1, 2]) });
    expect(rows.map((row) => row.account.code)).toEqual(["1000", "2000"]);
  });
});

describe("the chart of accounts as five categories", () => {
  it("groups the accounts into the five types, in the order of the balance sheet", () => {
    nextId = 1;
    const accounts = [
      account({ code: "4000", type: "income" }),
      account({ code: "1000", type: "asset" }),
      account({ code: "3000", type: "equity" }),
      account({ code: "5000", type: "expense" }),
      account({ code: "2000", type: "liability" }),
    ];

    const categories = buildCategoryTrees(accounts);

    expect(categories.map((category) => category.label)).toEqual([
      "Assets",
      "Liabilities",
      "Equity",
      "Income",
      "Expenses",
    ]);
    // Each category holds only its own accounts.
    expect(categories[0]?.rows.map((row) => row.account.code)).toEqual(["1000"]);
    expect(categories[3]?.rows.map((row) => row.account.code)).toEqual(["4000"]);
  });

  it("adds a category up without counting a parent and its child twice", () => {
    nextId = 1;
    const parent = account({ id: 1, code: "1000", balanceFils: 0 });
    const child = account({ id: 2, code: "1050", parentId: 1, balanceFils: 2_500 });
    const other = account({ id: 3, code: "1010", balanceFils: 1_000 });

    const [assets] = buildCategoryTrees([parent, child, other]);

    // The category total is the sum over its root accounts, each of which
    // already carries its own sub-accounts: 2,500 + 1,000.
    expect(assets?.totalBalanceFils).toBe(3_500);
    expect(assets?.accountCount).toBe(3);
  });

  it("keeps a parent's own balance apart from the branch's", () => {
    nextId = 1;
    const parent = account({ id: 1, code: "1000", balanceFils: 500 });
    const child = account({ id: 2, code: "1050", parentId: 1, balanceFils: 2_500 });

    const aggregated = aggregatedBalances([parent, child]);

    // The parent holds 500 of its own and 3,000 including its sub-account.
    expect(aggregated.get(1)).toBe(3_000);
    expect(aggregated.get(2)).toBe(2_500);
  });

  it("puts the branches back together from the flattened tree", () => {
    nextId = 1;
    const parent = account({ id: 1, code: "1000" });
    const child = account({ id: 2, code: "1050", parentId: 1 });
    const grandchild = account({ id: 3, code: "1055", parentId: 2 });

    const branches = buildBranches(buildAccountTree([parent, child, grandchild]));

    expect(branches).toHaveLength(1);
    expect(branches[0]?.children[0]?.children[0]?.account.code).toBe("1055");
  });

  it("keeps a parent's children in the branch, so a fold can be animated", () => {
    nextId = 1;
    const parent = account({ id: 1, code: "1000" });
    const child = account({ id: 2, code: "1050", parentId: 1 });

    // The tree is built whole and folded by the view, so the child is still
    // there to be folded - and the parent still knows it has one.
    const branches = buildBranches(buildAccountTree([parent, child]));

    expect(branches[0]?.children).toHaveLength(1);
    expect(branches[0]?.children[0]?.account.code).toBe("1050");
    expect(branches[0]?.childCount).toBe(1);
  });
});
