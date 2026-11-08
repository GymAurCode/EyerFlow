/**
 * The Chart of Accounts.
 *
 * The list of accounts the business keeps its books in, grouped by type. It is
 * the spine of the whole Finance module: every journal line names one of
 * these accounts, and every report groups by them.
 *
 * The screen is a pair of panels. On the left is the chart itself - five
 * categories, the accounts under them, folded up the way a filing cabinet is.
 * On the right is the account that is selected: what it is, what it holds, and
 * every journal line that has passed through it.
 *
 * Nothing on the right is calculated here. The balance is the account's own
 * balance out of the chart; the opening balance, the totals and the running
 * balance come from the general ledger, which is the same read the Account
 * Ledger page makes - so the two screens cannot tell different stories about
 * the same account.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import type { AccountDto, AccountType } from "../../../shared/finance";
import { call, errorMessage } from "../../lib/api";
import { useApp } from "../../lib/app-context";
import { resolveDateRange, type DateRangePreset } from "../../lib/finance";
import { IMS_PATH } from "../../lib/ims-nav";
import {
  accountsWithChildren,
  buildCategoryTrees,
  closeOverAncestors,
} from "../../lib/account-tree";
import { FinanceLayout } from "./FinanceLayout";
import { AccountTreePanel } from "./AccountTreePanel";
import { AccountDetailPanel, type AccountDetailTab } from "./AccountDetailPanel";
import { AccountEditorDialog } from "./AccountEditorDialog";

export function ChartOfAccountsPage(): React.JSX.Element {
  const { can } = useApp();
  const client = useQueryClient();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("");

  /** The categories whose accounts are folded away. */
  const [collapsedCategories, setCollapsedCategories] = useState<ReadonlySet<AccountType>>(
    () => new Set<AccountType>(),
  );
  /** The accounts whose sub-accounts are folded away. */
  const [collapsedAccounts, setCollapsedAccounts] = useState<ReadonlySet<number>>(
    () => new Set<number>(),
  );

  const [tab, setTab] = useState<AccountDetailTab>("overview");
  const [preset, setPreset] = useState<DateRangePreset>("month");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");

  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<AccountDto | null>(null);

  const { data } = useQuery({
    queryKey: ["finance.chart"],
    queryFn: () => call("finance.chart", {}),
  });

  const accounts = useMemo(() => data ?? [], [data]);

  /**
   * The selected account lives in the URL.
   *
   * That is what lets the reader go to the ledger and come back to the same
   * account with the same period, instead of arriving at a chart with nothing
   * selected and having to find their way again.
   */
  const selectedCode = searchParams.get("account");
  const selected = useMemo(
    () => accounts.find((account) => account.code === selectedCode) ?? null,
    [accounts, selectedCode],
  );

  const period = useMemo(
    () => resolveDateRange(preset, customFrom, customTo),
    [preset, customFrom, customTo],
  );

  const isFiltering = search.trim().length > 0 || typeFilter.length > 0;

  const matching = useMemo(() => {
    const term = search.trim().toLowerCase();
    return accounts.filter((account) => {
      if (typeFilter.length > 0 && account.type !== typeFilter) return false;
      if (term.length === 0) return true;
      return (
        account.code.toLowerCase().includes(term) ||
        account.name.toLowerCase().includes(term) ||
        (account.description ?? "").toLowerCase().includes(term)
      );
    });
  }, [accounts, search, typeFilter]);

  // A search shows the matches *and* the path to them, with every branch
  // open, so a match can never be hidden inside a branch the reader folded up.
  const visibleIds = useMemo(
    () =>
      isFiltering
        ? closeOverAncestors(accounts, new Set(matching.map((account) => account.id)))
        : undefined,
    [accounts, matching, isFiltering],
  );

  const categories = useMemo(
    () =>
      // The tree is built whole: folding a branch is the panel's job, not the
      // tree's, because a branch that is folded has to stay in the document
      // for the fold itself to be animated.
      buildCategoryTrees(accounts, { visibleIds }),
    [accounts, visibleIds],
  );

  const parents = useMemo(() => accountsWithChildren(accounts), [accounts]);

  const select = useCallback(
    (account: AccountDto): void => {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          next.set("account", account.code);
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  // An account that has gone - deleted, or renamed - must not leave the
  // panel showing something that is no longer there.
  useEffect(() => {
    if (selectedCode === null || selected !== null) return;
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete("account");
        return next;
      },
      { replace: true },
    );
  }, [selectedCode, selected, setSearchParams]);

  const toggleCategory = useCallback((type: AccountType): void => {
    setCollapsedCategories((current) => {
      const next = new Set(current);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }, []);

  const toggleAccount = useCallback((id: number): void => {
    setCollapsedAccounts((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const expandAll = useCallback((): void => {
    setCollapsedCategories(new Set<AccountType>());
    setCollapsedAccounts(new Set<number>());
  }, []);

  const collapseAll = useCallback((): void => {
    setCollapsedCategories(
      new Set<AccountType>(["asset", "liability", "equity", "income", "expense"]),
    );
    setCollapsedAccounts(new Set(parents));
  }, [parents]);

  const openEditor = useCallback((account: AccountDto | null): void => {
    setEditing(account);
    setEditorOpen(true);
  }, []);

  const exportChart = useCallback((): void => {
    void call("finance.chart.export", {})
      .then((result) => {
        toast.success(`Saved to ${result.path}`);
      })
      .catch((error: unknown) => {
        toast.error(errorMessage(error));
      });
  }, []);

  const viewLedger = useCallback((): void => {
    if (selected === null) return;
    void navigate(
      `${IMS_PATH.accountLedger}?code=${encodeURIComponent(selected.code)}&from=${period.fromDate}&to=${period.toDate}`,
    );
  }, [navigate, selected, period]);

  return (
    <FinanceLayout>
      {/*
        Two panels side by side once there is room for both: the chart needs
        about 340px to be readable and the detail needs more than that for a
        ledger table to fit. Below that the panels stack, so neither of them
        is squeezed into a column too narrow to read.
      */}
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(320px,36%)_minmax(0,1fr)]">
        <AccountTreePanel
          categories={categories}
          accounts={accounts}
          selectedCode={selectedCode}
          collapsedCategories={collapsedCategories}
          collapsedAccounts={collapsedAccounts}
          search={search}
          typeFilter={typeFilter}
          isFiltering={isFiltering}
          canCreate={can("finance", "create")}
          canExport={can("finance", "export")}
          onSearchChange={setSearch}
          onTypeFilterChange={setTypeFilter}
          onToggleCategory={toggleCategory}
          onToggleAccount={toggleAccount}
          onSelect={select}
          onExpandAll={expandAll}
          onCollapseAll={collapseAll}
          onAdd={() => {
            openEditor(null);
          }}
          onExport={exportChart}
        />

        <AccountDetailPanel
          account={selected}
          accounts={accounts}
          tab={tab}
          preset={preset}
          customFrom={customFrom}
          customTo={customTo}
          period={period}
          canEdit={can("finance", "edit")}
          onTabChange={setTab}
          onPresetChange={setPreset}
          onCustomFromChange={setCustomFrom}
          onCustomToChange={setCustomTo}
          onEdit={() => {
            if (selected !== null) openEditor(selected);
          }}
          onViewLedger={viewLedger}
        />
      </div>

      <AccountEditorDialog
        open={editorOpen}
        account={editing}
        accounts={accounts}
        onClose={() => {
          setEditorOpen(false);
          setEditing(null);
        }}
        onSaved={() => {
          void client.invalidateQueries({ queryKey: ["finance.chart"] });
        }}
        onDeleted={() => {
          void client.invalidateQueries({ queryKey: ["finance.chart"] });
        }}
      />
    </FinanceLayout>
  );
}
