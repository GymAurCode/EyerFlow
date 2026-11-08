/**
 * The account tree: the navigation half of the Chart of Accounts.
 *
 * The chart is a hierarchy - five categories, and inside each of them accounts
 * that may have sub-accounts of their own - so it is shown as a tree rather
 * than as a flat list. Folding it up is how a shopkeeper sees the shape of
 * their books instead of every line of them.
 *
 * Two things are kept deliberately apart:
 *
 *   - an account's own balance, which is what was posted to it, and
 *   - the aggregated balance of a branch, which is that plus its sub-accounts.
 *
 * They are the same number for almost every account and different for exactly
 * the ones that have children, so the tree says which is which rather than
 * quietly showing the larger figure.
 */

import { useMemo } from "react";
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  CreditCard,
  Download,
  Landmark,
  Plus,
  Receipt,
  Search,
  TrendingUp,
  Wallet,
} from "lucide-react";
import type { AccountDto, AccountType } from "../../../shared/finance";
import { cn } from "../../lib/utils";
import { formatAmount } from "../../lib/format";
import {
  buildBranches,
  type AccountBranchNode,
  type AccountCategoryTree,
} from "../../lib/account-tree";
import { Button } from "../../components/ui/Button";
import { Field, Input, Select } from "../../components/ui/Input";
import { EmptyState, Tooltip } from "../../components/ui/Feedback";

/** One icon per category: what the category is, said quietly. */
const CATEGORY_ICONS: Readonly<Record<AccountType, typeof Wallet>> = {
  asset: Wallet,
  liability: CreditCard,
  equity: Landmark,
  income: TrendingUp,
  expense: Receipt,
};

/** The ink each category icon wears. Identity colours, never states. */
const CATEGORY_INK: Readonly<Record<AccountType, string>> = {
  asset: "text-[var(--gold)]",
  liability: "text-[var(--warning)]",
  equity: "text-[var(--violet)]",
  income: "text-[var(--teal)]",
  expense: "text-[var(--danger)]",
};

const TYPE_OPTIONS: readonly { value: string; label: string }[] = [
  { value: "asset", label: "Asset" },
  { value: "liability", label: "Liability" },
  { value: "equity", label: "Equity" },
  { value: "income", label: "Income" },
  { value: "expense", label: "Expense" },
];

/** How far one level of the tree is indented. */
const INDENT_PX = 14;

export interface AccountTreePanelProps {
  readonly categories: readonly AccountCategoryTree[];
  readonly accounts: readonly AccountDto[];
  readonly selectedCode: string | null;
  readonly collapsedCategories: ReadonlySet<AccountType>;
  readonly collapsedAccounts: ReadonlySet<number>;
  readonly search: string;
  readonly typeFilter: string;
  readonly isFiltering: boolean;
  readonly canCreate: boolean;
  readonly canExport: boolean;
  readonly onSearchChange: (value: string) => void;
  readonly onTypeFilterChange: (value: string) => void;
  readonly onToggleCategory: (type: AccountType) => void;
  readonly onToggleAccount: (id: number) => void;
  readonly onSelect: (account: AccountDto) => void;
  readonly onExpandAll: () => void;
  readonly onCollapseAll: () => void;
  readonly onAdd: () => void;
  readonly onExport: () => void;
}

export function AccountTreePanel({
  categories,
  accounts,
  selectedCode,
  collapsedCategories,
  collapsedAccounts,
  search,
  typeFilter,
  isFiltering,
  canCreate,
  canExport,
  onSearchChange,
  onTypeFilterChange,
  onToggleCategory,
  onToggleAccount,
  onSelect,
  onExpandAll,
  onCollapseAll,
  onAdd,
  onExport,
}: AccountTreePanelProps): React.JSX.Element {
  const totals = useMemo(
    () => ({
      count: accounts.length,
      active: accounts.filter((account) => account.isActive).length,
    }),
    [accounts],
  );

  const visibleCount = categories.reduce((sum, category) => sum + category.rows.length, 0);
  // There is always something to fold - the five categories - and something to
  // open whenever an account has sub-accounts of its own.
  const canFold = categories.some((category) => category.rows.length > 0);
  const hasHierarchy = useMemo(
    () => categories.some((category) => category.rows.some((row) => row.childCount > 0)),
    [categories],
  );

  return (
    <section aria-label="Chart of accounts" className="card glass flex flex-col overflow-hidden">
      {/* The heading lives in this panel rather than above the whole page:
          the page is a pair of panels, and the chart is the one on the left. */}
      <div className="border-b border-[var(--border)] px-4 pb-3.5 pt-4">
        <div className="flex items-start justify-between gap-2">
          <h1 className="text-[18px] font-semibold leading-7 text-[var(--text)]">
            Chart of Accounts
          </h1>

          <div className="flex shrink-0 items-center gap-1.5">
            {canExport && (
              <Tooltip content="Export the chart">
                <Button
                  variant="ghost"
                  size="icon"
                  iconOnlyLabel="Export the chart"
                  onClick={onExport}
                >
                  <Download className="h-4 w-4" aria-hidden="true" />
                </Button>
              </Tooltip>
            )}
            {canCreate && (
              <Button
                variant="primary"
                size="sm"
                iconLeft={<Plus className="h-4 w-4" />}
                onClick={onAdd}
              >
                Add Account
              </Button>
            )}
          </div>
        </div>

        <p className="mt-0.5 text-[12.5px] leading-relaxed text-[var(--text-2)]">
          Accounts organise the business&apos;s financial transactions.
        </p>

        <div className="mt-3.5 flex flex-wrap items-center gap-2">
          <div className="min-w-[180px] flex-1">
            <Field label="Search" srLabelOnly>
              {(id) => (
                <div className="relative">
                  <Search
                    className="pointer-events-none absolute inset-y-0 start-3 my-auto h-4 w-4 text-[var(--text-3)]"
                    aria-hidden="true"
                  />
                  <Input
                    id={id}
                    value={search}
                    onChange={(event) => {
                      onSearchChange(event.target.value);
                    }}
                    placeholder="Search code or name"
                    className="ps-9"
                  />
                </div>
              )}
            </Field>
          </div>

          <div className="w-[150px]">
            <Select
              value={typeFilter}
              options={TYPE_OPTIONS}
              placeholder="All types"
              onChange={(value) => {
                onTypeFilterChange(value);
              }}
              aria-label="Filter by account type"
            />
          </div>
        </div>

        <div className="mt-2.5 flex items-center gap-1">
          <Tooltip content="Open every category and every branch">
            <Button
              variant="ghost"
              size="sm"
              iconLeft={<ChevronsUpDown className="h-3.5 w-3.5" />}
              onClick={onExpandAll}
              disabled={!hasHierarchy && collapsedCategories.size === 0}
            >
              Expand all
            </Button>
          </Tooltip>
          <Tooltip content="Fold every category and branch up">
            <Button
              variant="ghost"
              size="sm"
              iconLeft={<ChevronsDownUp className="h-3.5 w-3.5" />}
              onClick={onCollapseAll}
              disabled={!canFold}
            >
              Collapse all
            </Button>
          </Tooltip>

          <span className="ms-auto text-[12px] text-[var(--text-3)]">
            {isFiltering
              ? `${String(visibleCount)} shown of ${String(totals.count)}`
              : `${String(totals.count)} accounts`}
          </span>
        </div>
      </div>

      {/* The tree. It scrolls inside the panel rather than stretching the page,
          so the detail panel beside it keeps its place on screen. Stacked
          under the detail panel it is kept shorter still, so the account the
          reader picked is not a whole screen away. */}
      <div className="max-h-[320px] min-h-[220px] flex-1 overflow-y-auto overscroll-contain xl:max-h-[min(64vh,40rem)] xl:min-h-[320px]">
        {visibleCount === 0 ? (
          <EmptyState
            compact
            icon={<Search className="h-5 w-5" />}
            title={isFiltering ? "No accounts match" : "No accounts yet"}
            description={
              isFiltering
                ? "Clear the search or the type filter to see the whole chart."
                : "Add the first account to start keeping the books."
            }
          />
        ) : (
          categories.map((category) => (
            <CategoryGroup
              key={category.type}
              category={category}
              selectedCode={selectedCode}
              collapsedCategories={collapsedCategories}
              collapsedAccounts={collapsedAccounts}
              isFiltering={isFiltering}
              onToggleCategory={onToggleCategory}
              onToggleAccount={onToggleAccount}
              onSelect={onSelect}
            />
          ))
        )}
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */

function CategoryGroup({
  category,
  selectedCode,
  collapsedCategories,
  collapsedAccounts,
  isFiltering,
  onToggleCategory,
  onToggleAccount,
  onSelect,
}: {
  readonly category: AccountCategoryTree;
  readonly selectedCode: string | null;
  readonly collapsedCategories: ReadonlySet<AccountType>;
  readonly collapsedAccounts: ReadonlySet<number>;
  readonly isFiltering: boolean;
  readonly onToggleCategory: (type: AccountType) => void;
  readonly onToggleAccount: (id: number) => void;
  readonly onSelect: (account: AccountDto) => void;
}): React.JSX.Element {
  const Icon = CATEGORY_ICONS[category.type];
  // A search opens every category: a match must never be hidden inside a
  // category the reader had folded up before they searched.
  const collapsed = !isFiltering && collapsedCategories.has(category.type);
  const shown = category.rows.length;

  return (
    <section className="border-b border-[var(--border)] last:border-b-0">
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={() => {
          onToggleCategory(category.type);
        }}
        className={cn(
          "flex w-full items-center gap-2 px-3 py-2 text-start transition-colors duration-fast",
          "hover:bg-[var(--surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--brand)]",
        )}
      >
        {collapsed ? (
          <ChevronRight className="h-4 w-4 shrink-0 text-[var(--text-3)]" aria-hidden="true" />
        ) : (
          <ChevronDown className="h-4 w-4 shrink-0 text-[var(--text-3)]" aria-hidden="true" />
        )}

        <span
          className={cn(
            "glass-chip h-6 w-6 shrink-0 text-[var(--text-2)]",
            category.type === "asset" && "chip-gold",
            category.type === "liability" && "chip-amber",
            category.type === "equity" && "chip-violet",
            category.type === "income" && "chip-teal",
            category.type === "expense" && "chip-rose",
          )}
        >
          <Icon className={cn("h-3.5 w-3.5", CATEGORY_INK[category.type])} aria-hidden="true" />
        </span>

        <span className="text-[13px] font-semibold text-[var(--text)]">{category.label}</span>
        <span className="text-[11.5px] text-[var(--text-3)]">
          {isFiltering ? `${String(shown)} shown` : `${String(category.accountCount)} accounts`}
        </span>

        {/* The category figure is an aggregate of the accounts inside it, not
            a balance of its own, so it says so. */}
        {!isFiltering && category.totalBalanceFils !== 0 && (
          <span className="tabular ms-auto text-[12px] font-medium text-[var(--text-2)]">
            {formatAmount(category.totalBalanceFils)}
          </span>
        )}
      </button>

      {/*
        The branch is folded with a grid row rather than by unmounting it, so
        the open and close can be animated. `inert` takes the folded branch
        out of the tab order and out of the accessibility tree, which a
        zero-height container on its own would not.
      */}
      <div
        className="grid transition-[grid-template-rows] duration-200 ease-glass"
        style={{ gridTemplateRows: collapsed ? "0fr" : "1fr" }}
      >
        <div className="min-h-0 overflow-hidden" inert={collapsed}>
          {buildBranches(category.rows).map((branch) => (
            <AccountBranch
              key={branch.account.id}
              branch={branch}
              selectedCode={selectedCode}
              collapsedAccounts={collapsedAccounts}
              isFiltering={isFiltering}
              onToggleAccount={onToggleAccount}
              onSelect={onSelect}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * One account, and the accounts under it.
 *
 * The recursion is what makes a sub-account of a sub-account work: a branch
 * knows its own children and hands them to the same component.
 */
function AccountBranch({
  branch,
  selectedCode,
  collapsedAccounts,
  isFiltering,
  onToggleAccount,
  onSelect,
}: {
  readonly branch: AccountBranchNode;
  readonly selectedCode: string | null;
  readonly collapsedAccounts: ReadonlySet<number>;
  readonly isFiltering: boolean;
  readonly onToggleAccount: (id: number) => void;
  readonly onSelect: (account: AccountDto) => void;
}): React.JSX.Element {
  const account = branch.account;
  const selected = account.code === selectedCode;
  const hasChildren = branch.childCount > 0;
  // A search opens every branch: a match must never be hidden inside a
  // branch the reader had folded up before they searched.
  const collapsed = !isFiltering && collapsedAccounts.has(account.id);

  return (
    <>
      <div
        className={cn(
          "group relative flex items-center gap-1.5 pr-3 transition-colors duration-fast",
          selected ? "bg-[var(--brand-soft)]" : "hover:bg-[var(--surface-2)]",
        )}
        style={{ paddingInlineStart: `${String(branch.depth * INDENT_PX + 8)}px` }}
      >
        {selected && (
          <span
            className="absolute inset-y-1 start-0 w-[3px] rounded-full bg-[var(--brand)]"
            aria-hidden="true"
          />
        )}

        {hasChildren ? (
          <button
            type="button"
            aria-expanded={!collapsed}
            aria-label={collapsed ? `Expand ${account.name}` : `Collapse ${account.name}`}
            title={
              collapsed
                ? `Expand ${String(branch.childCount)} sub-account${branch.childCount === 1 ? "" : "s"}`
                : "Collapse"
            }
            onClick={(event) => {
              // The chevron folds the branch. It must not also select the
              // account: the two are different intentions.
              event.stopPropagation();
              onToggleAccount(account.id);
            }}
            className={cn(
              "flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--text-3)]",
              "transition-colors duration-fast hover:bg-[var(--surface-3)] hover:text-[var(--text)]",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]",
            )}
          >
            {collapsed ? (
              <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
            )}
          </button>
        ) : (
          <span className="h-5 w-5 shrink-0" aria-hidden="true" />
        )}

        <button
          type="button"
          onClick={() => {
            onSelect(account);
          }}
          aria-current={selected ? "true" : undefined}
          className={cn(
            "flex min-w-0 flex-1 items-baseline gap-2 rounded py-1.5 text-start",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]",
          )}
        >
          <span className="tabular shrink-0 text-[12px] font-medium text-[var(--text-2)]">
            {account.code}
          </span>
          <span
            className={cn(
              "truncate text-[13px]",
              selected ? "font-medium text-[var(--text)]" : "text-[var(--text)]",
              !account.isActive && "text-[var(--text-3)] line-through decoration-1",
            )}
          >
            {account.name}
          </span>
          {!account.isActive && (
            <span className="shrink-0 text-[10.5px] uppercase tracking-wide text-[var(--text-3)]">
              Inactive
            </span>
          )}
        </button>

        <span
          className={cn(
            "tabular shrink-0 text-[12px]",
            account.balanceFils === 0 ? "text-[var(--text-3)]" : "font-medium text-[var(--text-2)]",
          )}
        >
          {account.balanceFils === 0 ? "—" : formatAmount(account.balanceFils)}
        </span>
      </div>

      {hasChildren && (
        <div
          className="grid transition-[grid-template-rows] duration-200 ease-glass"
          style={{ gridTemplateRows: collapsed ? "0fr" : "1fr" }}
        >
          <div className="min-h-0 overflow-hidden" inert={collapsed}>
            {branch.children.map((child) => (
              <AccountBranch
                key={child.account.id}
                branch={child}
                selectedCode={selectedCode}
                collapsedAccounts={collapsedAccounts}
                isFiltering={isFiltering}
                onToggleAccount={onToggleAccount}
                onSelect={onSelect}
              />
            ))}
          </div>
        </div>
      )}
    </>
  );
}
