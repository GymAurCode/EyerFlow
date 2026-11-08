/**
 * The detail half of the Chart of Accounts.
 *
 * One account, everything the books know about it, and where the money went:
 * the balance, the period's activity, and the journal lines behind both.
 *
 * Every figure here comes out of the same ledger the General Ledger reads, so
 * the two cannot disagree. The account's *current* balance is its own balance
 * across all posted history; the period's opening balance, debits, credits
 * and running balance come from the ledger for the range in force. They are
 * labelled separately because they are different things.
 *
 * Balances follow the account's own normal balance. An asset grows with a
 * debit, a liability and a revenue grow with a credit, and the three accounts
 * in the default chart that break the pattern - accumulated depreciation,
 * owner's drawings and sales returns - carry their own normal balance, so no
 * figure on this screen has to guess which way round it is.
 */

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeftRight,
  ChevronLeft,
  ChevronRight,
  FileText,
  Pencil,
  ScrollText,
  Search,
} from "lucide-react";
import type {
  AccountDto,
  GeneralLedgerDto,
  JournalEntryDetailDto,
  LedgerLineDto,
} from "../../../shared/finance";
import { call } from "../../lib/api";
import { cn } from "../../lib/utils";
import { formatAmount, formatMoney } from "../../lib/format";
import {
  ACCOUNT_SUBTYPE_LABELS,
  ACCOUNT_TYPE_LABELS,
  JOURNAL_SOURCE_LABELS,
  type DateRange,
  type DateRangePreset,
} from "../../lib/finance";
import { aggregatedBalances } from "../../lib/account-tree";
import { Badge, type BadgeTone } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { type Column, DataTable } from "../../components/ui/DataTable";
import { HighlightText } from "../../components/ui/HighlightText";
import { EmptyState, TableSkeleton, Tooltip } from "../../components/ui/Feedback";
import { Input } from "../../components/ui/Input";
import { useSearchHighlight, type SearchHighlight } from "../../lib/search-highlight";
import { DateRangePicker } from "./FinanceLayout";

/** The three things this panel can show about an account. */
export type AccountDetailTab = "overview" | "history" | "information";

const DETAIL_TABS: readonly { readonly id: AccountDetailTab; readonly label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "history", label: "Transaction History" },
  { id: "information", label: "Account Information" },
];

/** Presets offered for the period. "Last month" is here rather than in the
    shared list because only this screen needs a previous calendar month. */
const PERIOD_PRESETS: readonly { readonly value: string; readonly label: string }[] = [
  { value: "month", label: "This month" },
  { value: "lastMonth", label: "Last month" },
  { value: "quarter", label: "This quarter" },
  { value: "year", label: "This year" },
  { value: "custom", label: "Custom" },
];

/** Rows per page in the transaction history. */
const PAGE_SIZE = 20;

const ledgerKey = (row: LedgerLineDto): number => row.lineId;

/** The same five fields the transaction search has always matched. */
const LEDGER_SEARCH_FIELDS = [
  (row: LedgerLineDto) => row.entryNo,
  (row: LedgerLineDto) => row.documentNumber,
  (row: LedgerLineDto) => row.description,
  (row: LedgerLineDto) => row.partyName,
  (row: LedgerLineDto) => row.reference,
];

const LEDGER_RANK_FIELDS = [
  (row: LedgerLineDto) => row.documentNumber,
  (row: LedgerLineDto) => row.entryNo,
  (row: LedgerLineDto) => row.description,
];

/**
 * Below this panel width the reference and status columns are dropped.
 *
 * A ledger table has to fit: a column pushed off the edge is worse than a
 * column that is not there. The reference moves under the description and the
 * status - which a reader can infer from a "Reversal" source - is left out.
 */
const NARROW_PANEL_PX = 820;

const TYPE_TONES: Readonly<Record<string, BadgeTone>> = {
  asset: "gold",
  liability: "warning",
  equity: "violet",
  income: "success",
  expense: "danger",
};

const SOURCE_TONES: Readonly<Record<string, BadgeTone>> = {
  sale: "success",
  purchase: "info",
  expense: "warning",
  payment: "brand",
  transfer: "violet",
  reversal: "danger",
  adjustment: "violet",
  manual: "neutral",
  opening: "neutral",
};

export interface AccountDetailPanelProps {
  readonly account: AccountDto | null;
  readonly accounts: readonly AccountDto[];
  readonly tab: AccountDetailTab;
  readonly preset: DateRangePreset;
  readonly customFrom: string;
  readonly customTo: string;
  readonly period: DateRange;
  readonly canEdit: boolean;
  readonly onTabChange: (tab: AccountDetailTab) => void;
  readonly onPresetChange: (preset: DateRangePreset) => void;
  readonly onCustomFromChange: (value: string) => void;
  readonly onCustomToChange: (value: string) => void;
  readonly onEdit: () => void;
  readonly onViewLedger: () => void;
}

export function AccountDetailPanel({
  account,
  accounts,
  tab,
  preset,
  customFrom,
  customTo,
  period,
  canEdit,
  onTabChange,
  onPresetChange,
  onCustomFromChange,
  onCustomToChange,
  onEdit,
  onViewLedger,
}: AccountDetailPanelProps): React.JSX.Element {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [entryId, setEntryId] = useState<number | null>(null);

  const { ref: panelRef, width: panelWidth } = useElementWidth<HTMLElement>();

  const { data: ledger, isLoading } = useQuery({
    queryKey: ["finance.generalLedger", account?.code ?? "", period.fromDate, period.toDate],
    queryFn: () =>
      call("finance.generalLedger", {
        code: account?.code ?? "",
        fromDate: period.fromDate,
        toDate: period.toDate,
      }),
    enabled: account !== null,
  });

  const aggregates = useMemo(() => aggregatedBalances(accounts), [accounts]);
  const aggregatedFils = account === null ? 0 : (aggregates.get(account.id) ?? account.balanceFils);

  const parent = useMemo(
    () =>
      account?.parentId === null || account?.parentId === undefined
        ? undefined
        : accounts.find((candidate) => candidate.id === account.parentId),
    [accounts, account],
  );

  // A new search starts at the first page, then moves to the best match if
  // there is one. Staying on page 7 of a list that has just been filtered is
  // how a reader ends up looking at nothing.
  const ledgerRows = useMemo(() => ledger?.rows ?? [], [ledger]);
  const highlight = useSearchHighlight(ledgerRows, search, {
    rowKey: ledgerKey,
    fields: LEDGER_SEARCH_FIELDS,
    rankFields: LEDGER_RANK_FIELDS,
  });

  const filtered = useMemo(
    () =>
      highlight.active
        ? ledgerRows.filter((row) => highlight.keys.has(ledgerKey(row)))
        : ledgerRows,
    [ledgerRows, highlight],
  );

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const pageRows = filtered.slice(currentPage * PAGE_SIZE, currentPage * PAGE_SIZE + PAGE_SIZE);

  // Jump once to the page holding the best match. Manual paging afterwards is
  // the reader's, so the handled key is remembered until the search changes.
  const handledFocusRef = useRef<string | number | null>(null);
  useEffect(() => {
    const key = highlight.primaryKey;
    if (key === null) {
      handledFocusRef.current = null;
      return;
    }
    if (handledFocusRef.current === key) return;

    const index = filtered.findIndex((row) => ledgerKey(row) === key);
    if (index < 0) return;

    handledFocusRef.current = key;
    setPage(Math.floor(index / PAGE_SIZE));
  }, [highlight.primaryKey, filtered]);

  if (account === null) {
    return (
      <section
        ref={panelRef}
        aria-label="Account details"
        className="card glass flex min-h-[420px] items-center justify-center"
      >
        <EmptyState
          icon={<ScrollText className="h-5 w-5" />}
          title="Select an account"
          description="Select an account to view its details, balance, and transaction history."
        />
      </section>
    );
  }

  return (
    <section ref={panelRef} aria-label="Account details" className="card glass overflow-hidden">
      {/* The header: who this account is, and the three things one can do
          with it. */}
      <header className="border-b border-[var(--border)] px-4 py-3.5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-[17px] font-semibold leading-tight text-[var(--text)]">
                {account.name}
              </h2>
              <span className="tabular rounded-md bg-[var(--surface-2)] px-1.5 py-0.5 text-[11.5px] font-medium text-[var(--text-2)]">
                {account.code}
              </span>
              <Badge tone={TYPE_TONES[account.type] ?? "neutral"}>
                {ACCOUNT_TYPE_LABELS[account.type] ?? account.type}
              </Badge>
              <Badge tone={account.isActive ? "success" : "neutral"}>
                {account.isActive ? "Active" : "Inactive"}
              </Badge>
              {account.isSystem && <Badge tone="brand">System</Badge>}
            </div>

            <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px] text-[var(--text-3)]">
              {parent !== undefined && (
                <span>
                  Under{" "}
                  <span className="tabular text-[var(--text-2)]">
                    {parent.code} {parent.name}
                  </span>
                </span>
              )}
              <span>
                {account.normalBalance === "debit"
                  ? "Increases with debits"
                  : "Increases with credits"}
              </span>
              <span>
                {String(account.usageCount)} ledger line{account.usageCount === 1 ? "" : "s"}
              </span>
            </p>

            {account.description !== null && account.description.length > 0 && (
              <p className="mt-1.5 max-w-2xl text-[12.5px] leading-relaxed text-[var(--text-2)]">
                {account.description}
              </p>
            )}
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            {canEdit && (
              <Button
                variant="secondary"
                size="sm"
                iconLeft={<Pencil className="h-3.5 w-3.5" />}
                onClick={onEdit}
              >
                Edit Account
              </Button>
            )}
            <Button
              variant="secondary"
              size="sm"
              iconLeft={<ScrollText className="h-3.5 w-3.5" />}
              onClick={onViewLedger}
            >
              View Ledger
            </Button>
            <Button
              variant="ghost"
              size="sm"
              iconLeft={<ArrowLeftRight className="h-3.5 w-3.5" />}
              onClick={() => {
                onTabChange("history");
              }}
            >
              Transaction History
            </Button>
          </div>
        </div>
      </header>

      {/* The period. It is above the tabs because it governs everything below
          them: the opening balance, the totals and the rows are all about the
          same range, so one control has to speak for all of them. */}
      <div className="flex flex-wrap items-center gap-3 border-b border-[var(--border)] bg-[var(--surface-2)] px-4 py-2.5">
        <DateRangePicker
          preset={preset}
          fromDate={customFrom}
          toDate={customTo}
          presets={PERIOD_PRESETS}
          onPresetChange={(value) => {
            onPresetChange(value as DateRangePreset);
          }}
          onFromChange={onCustomFromChange}
          onToChange={onCustomToChange}
        />
        <span className="text-[12px] text-[var(--text-3)]">
          {period.fromDate} → {period.toDate}
        </span>
      </div>

      <div
        role="tablist"
        aria-label="Account details"
        className="flex gap-1 border-b border-[var(--border)] px-2"
      >
        {DETAIL_TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            onClick={() => {
              onTabChange(entry.id);
            }}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-[13px] font-medium transition-colors duration-fast",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]",
              tab === entry.id
                ? "border-[var(--brand)] text-[var(--brand)]"
                : "border-transparent text-[var(--text-2)] hover:border-[var(--border-strong)] hover:text-[var(--text)]",
            )}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {tab === "overview" && (
        <Overview
          account={account}
          ledger={ledger}
          isLoading={isLoading}
          period={period}
          aggregatedFils={aggregatedFils}
        />
      )}

      {tab === "history" && (
        <History
          rows={pageRows}
          filteredCount={filtered.length}
          totalCount={ledger?.rows.length ?? 0}
          openingBalanceFils={ledger?.openingBalanceFils ?? 0}
          search={search}
          page={currentPage}
          pageCount={pageCount}
          isLoading={isLoading}
          normalBalance={account.normalBalance}
          narrow={panelWidth > 0 && panelWidth < NARROW_PANEL_PX}
          highlight={highlight}
          onSearchChange={(value) => {
            setSearch(value);
            setPage(0);
          }}
          onPageChange={setPage}
          onOpenEntry={(id) => {
            setEntryId(id);
          }}
        />
      )}

      {tab === "information" && (
        <Information account={account} accounts={accounts} aggregatedFils={aggregatedFils} />
      )}

      <JournalEntryDialog
        entryId={entryId}
        onClose={() => {
          setEntryId(null);
        }}
      />
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* overview                                                                    */
/* -------------------------------------------------------------------------- */

function Overview({
  account,
  ledger,
  isLoading,
  period,
  aggregatedFils,
}: {
  readonly account: AccountDto;
  readonly ledger: GeneralLedgerDto | undefined;
  readonly isLoading: boolean;
  readonly period: DateRange;
  readonly aggregatedFils: number;
}): React.JSX.Element {
  const isDebitNormal = account.normalBalance === "debit";
  const activityFils =
    ledger === undefined ? 0 : ledger.closingBalanceFils - ledger.openingBalanceFils;

  return (
    <div className="space-y-4 p-4">
      {isLoading && ledger === undefined ? (
        <TableSkeleton columns={4} rows={2} />
      ) : (
        <>
          <div className="grid gap-px overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--border)] sm:grid-cols-4">
            <SummaryCell
              label="Current balance"
              value={formatMoney(account.balanceFils)}
              hint="Everything posted to this account, to date"
              emphasis
              className="sm:col-span-2 sm:row-span-2"
            />
            <SummaryCell
              label="Opening balance"
              value={formatMoney(ledger?.openingBalanceFils ?? 0)}
              hint={`Posted before ${period.fromDate}`}
            />
            <SummaryCell
              label="Total debits"
              value={formatMoney(ledger?.totalDebitFils ?? 0)}
              hint="Posted in this period"
            />
            <SummaryCell
              label="Total credits"
              value={formatMoney(ledger?.totalCreditFils ?? 0)}
              hint="Posted in this period"
            />
            <SummaryCell
              label="Period activity"
              value={formatMoney(activityFils)}
              hint={
                isDebitNormal
                  ? "Debits less credits, in this period"
                  : "Credits less debits, in this period"
              }
            />
          </div>

          <p className="text-[12.5px] leading-relaxed text-[var(--text-2)]">
            {account.name} is a{" "}
            <span className="font-medium text-[var(--text)]">
              {ACCOUNT_TYPE_LABELS[account.type]?.toLowerCase() ?? account.type}
            </span>{" "}
            that {isDebitNormal ? "grows with a debit" : "grows with a credit"}. Balances above are
            shown in that direction, so a positive figure is always the account holding more than it
            started with.
          </p>

          {aggregatedFils !== account.balanceFils && (
            <p className="text-[12.5px] leading-relaxed text-[var(--text-2)]">
              The figure above is this account&apos;s own balance. Its sub-accounts add up to{" "}
              <span className="tabular font-medium text-[var(--text)]">
                {formatMoney(aggregatedFils)}
              </span>
              , which is the branch total rather than the account&apos;s own money.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function SummaryCell({
  label,
  value,
  hint,
  emphasis = false,
  className,
}: {
  readonly label: string;
  readonly value: string;
  readonly hint: string;
  readonly emphasis?: boolean | undefined;
  readonly className?: string | undefined;
}): React.JSX.Element {
  return (
    <div className={cn("bg-[var(--surface)] px-3.5 py-3", className)}>
      <p className="text-[11px] uppercase tracking-wide text-[var(--text-3)]">{label}</p>
      <p
        className={cn(
          "tabular mt-0.5 text-[16px] leading-tight",
          emphasis ? "font-semibold text-[var(--text)]" : "font-medium text-[var(--text)]",
        )}
      >
        {value}
      </p>
      <p className="mt-0.5 text-[11px] leading-snug text-[var(--text-3)]">{hint}</p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* transaction history                                                         */
/* -------------------------------------------------------------------------- */

function History({
  rows,
  filteredCount,
  totalCount,
  openingBalanceFils,
  search,
  page,
  pageCount,
  isLoading,
  normalBalance,
  narrow,
  highlight,
  onSearchChange,
  onPageChange,
  onOpenEntry,
}: {
  readonly rows: readonly LedgerLineDto[];
  readonly filteredCount: number;
  readonly totalCount: number;
  readonly openingBalanceFils: number;
  readonly search: string;
  readonly page: number;
  readonly pageCount: number;
  readonly isLoading: boolean;
  readonly normalBalance: "debit" | "credit";
  readonly narrow: boolean;
  readonly highlight: SearchHighlight<LedgerLineDto>;
  readonly onSearchChange: (value: string) => void;
  readonly onPageChange: (page: number) => void;
  readonly onOpenEntry: (entryId: number) => void;
}): React.JSX.Element {
  const columns: readonly Column<LedgerLineDto>[] = [
    {
      id: "date",
      header: "Date",
      widthClass: "w-[96px]",
      cell: (row) => (
        <span className="tabular whitespace-nowrap text-[12.5px] text-[var(--text-2)]">
          {row.entryDate}
        </span>
      ),
      sortValue: (row) => row.entryDate,
    },
    {
      id: "reference",
      header: "Reference",
      widthClass: "w-[132px]",
      cell: (row) => (
        <button
          type="button"
          onClick={() => {
            onOpenEntry(row.entryId);
          }}
          title={`Open journal entry ${row.entryNo}`}
          className="group/ref min-w-0 w-full text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
        >
          <span className="tabular block truncate text-[11.5px] font-medium text-[var(--text)] underline decoration-transparent underline-offset-2 transition-colors duration-fast group-hover/ref:decoration-[var(--brand)]">
            <HighlightText text={row.documentNumber ?? row.entryNo} term={search} />
          </span>
          {row.documentNumber !== null && (
            <span className="tabular block truncate text-[10.5px] text-[var(--text-3)]">
              <HighlightText text={row.entryNo} term={search} />
            </span>
          )}
        </button>
      ),
      sortValue: (row) => row.documentNumber ?? row.entryNo,
    },
    {
      id: "source",
      header: "Source",
      widthClass: "w-[88px]",
      cell: (row) => (
        <Badge tone={SOURCE_TONES[row.source] ?? "neutral"}>
          {JOURNAL_SOURCE_LABELS[row.source] ?? row.source}
        </Badge>
      ),
      sortValue: (row) => row.source,
    },
    {
      id: "description",
      header: "Description",
      cell: (row) => (
        <div className="min-w-0" title={row.description ?? undefined}>
          <div className="truncate text-[13px] text-[var(--text)]">
            {row.description === null ? "—" : <HighlightText text={row.description} term={search} />}
          </div>
          {/*
            When the reference has no column of its own - the panel is too
            narrow for one - the entry number moves under the description
            rather than being pushed off the edge. The party and the reference
            are marked here too: either can be what was searched for, and a
            match the reader cannot see is not a highlight.
          */}
          <div className="truncate text-[11px] text-[var(--text-3)]">
            {[narrow ? row.entryNo : null, row.partyName, row.reference]
              .filter((value): value is string => value !== null && value.length > 0)
              .map((value, index) => (
                <Fragment key={`${String(index)}-${value}`}>
                  {index > 0 && " · "}
                  <HighlightText text={value} term={search} />
                </Fragment>
              ))}
          </div>
        </div>
      ),
      sortValue: (row) => row.description ?? "",
    },
    {
      id: "debit",
      header: "Debit",
      align: "end",
      widthClass: "w-[88px]",
      cell: (row) =>
        row.debitFils === 0 ? (
          <span className="text-[var(--text-3)]">—</span>
        ) : (
          <span className="tabular whitespace-nowrap text-[13px]">
            {formatAmount(row.debitFils)}
          </span>
        ),
      sortValue: (row) => row.debitFils,
    },
    {
      id: "credit",
      header: "Credit",
      align: "end",
      widthClass: "w-[88px]",
      cell: (row) =>
        row.creditFils === 0 ? (
          <span className="text-[var(--text-3)]">—</span>
        ) : (
          <span className="tabular whitespace-nowrap text-[13px]">
            {formatAmount(row.creditFils)}
          </span>
        ),
      sortValue: (row) => row.creditFils,
    },
    {
      id: "balance",
      header: "Balance",
      align: "end",
      widthClass: "w-[92px]",
      cell: (row) => (
        <span className="tabular whitespace-nowrap text-[13px] font-medium">
          {formatAmount(row.runningBalanceFils)}
        </span>
      ),
      sortValue: (row) => row.runningBalanceFils,
    },
    {
      id: "status",
      header: "Status",
      widthClass: "w-[84px]",
      cell: (row) => (
        <Badge tone={row.status === "reversed" ? "warning" : "neutral"}>
          {row.status === "reversed" ? "Reversed" : "Posted"}
        </Badge>
      ),
      sortValue: (row) => row.status,
    },
  ];

  const from = page * PAGE_SIZE + 1;
  const to = Math.min((page + 1) * PAGE_SIZE, filteredCount);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] px-4 py-2.5">
        <div className="w-[260px]">
          <div className="relative">
            <Search
              className="pointer-events-none absolute inset-y-0 start-3 my-auto h-4 w-4 text-[var(--text-3)]"
              aria-hidden="true"
            />
            <Input
              value={search}
              onChange={(event) => {
                onSearchChange(event.target.value);
              }}
              placeholder="Search transactions"
              aria-label="Search transactions"
              className="ps-9"
            />
          </div>
        </div>

        <span className="text-[12px] text-[var(--text-3)]">
          {search.trim().length > 0
            ? `${String(filteredCount)} of ${String(totalCount)} entries`
            : `${String(totalCount)} ${totalCount === 1 ? "entry" : "entries"}`}
        </span>

        {pageCount > 1 && (
          <div className="ms-auto flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="icon"
              iconOnlyLabel="Previous page"
              disabled={page === 0}
              onClick={() => {
                onPageChange(page - 1);
              }}
            >
              <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            </Button>
            <span className="tabular text-[12px] text-[var(--text-3)]">
              {String(from)}–{String(to)} of {String(filteredCount)}
            </span>
            <Button
              variant="ghost"
              size="icon"
              iconOnlyLabel="Next page"
              disabled={page >= pageCount - 1}
              onClick={() => {
                onPageChange(page + 1);
              }}
            >
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
        )}
      </div>

      {isLoading ? (
        <div className="p-4">
          <TableSkeleton columns={6} rows={6} />
        </div>
      ) : (
        <>
          {/*
            The opening balance sits above the rows rather than as the first
            one: it is where the period started, not something that happened
            during it, and a reader who adds it up as a movement counts it
            twice.
          */}
          <div className="flex items-baseline justify-between gap-3 border-b border-[var(--border)] bg-[var(--surface-2)] px-4 py-2">
            <span className="text-[12px] text-[var(--text-3)]">Opening balance</span>
            <span className="tabular text-[13px] font-medium text-[var(--text)]">
              {formatMoney(openingBalanceFils)}
            </span>
          </div>

          <DataTable
            frameless
            compact
            dense
            fixed
            columns={columns}
            rows={rows}
            rowKey={ledgerKey}
            hiddenColumnIds={narrow ? ["reference", "status"] : []}
            highlightedRowKeys={highlight.keys}
            primaryRowKey={highlight.primaryKey}
            scrollToRowKey={highlight.primaryKey}
            caption="Transactions on this account"
            emptyState={
              <EmptyState
                compact
                icon={<FileText className="h-5 w-5" />}
                title="No transactions in this period"
                description={
                  search.trim().length > 0
                    ? "No entry matches that search. Clear it to see the whole period."
                    : "Nothing has been posted to this account between these dates."
                }
              />
            }
          />
        </>
      )}

      <p className="border-t border-[var(--border)] px-4 py-2 text-[11.5px] text-[var(--text-3)]">
        The running balance follows the account&apos;s normal balance: a{" "}
        {normalBalance === "debit" ? "debit" : "credit"} raises it. It starts from the opening
        balance, which is everything posted before the period began.
      </p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* layout                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * How wide an element is.
 *
 * The panel's width decides what fits beside it, and the window can be
 * resized at any time, so the answer has to be measured rather than guessed
 * from the viewport: the rail can be collapsed, and the panels stack on a
 * narrow one.
 */
function useElementWidth<T extends HTMLElement>(): {
  readonly ref: React.RefObject<T | null>;
  readonly width: number;
} {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const element = ref.current;
    if (element === null) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry !== undefined) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    setWidth(element.clientWidth);

    return () => {
      observer.disconnect();
    };
  }, []);

  return { ref, width };
}

/* -------------------------------------------------------------------------- */
/* account information                                                         */
/* -------------------------------------------------------------------------- */
function Information({
  account,
  accounts,
  aggregatedFils,
}: {
  readonly account: AccountDto;
  readonly accounts: readonly AccountDto[];
  readonly aggregatedFils: number;
}): React.JSX.Element {
  const parent =
    account.parentId === null || account.parentId === undefined
      ? undefined
      : accounts.find((candidate) => candidate.id === account.parentId);

  const rows: readonly { readonly label: string; readonly value: string }[] = [
    { label: "Account name", value: account.name },
    { label: "Account code", value: account.code },
    { label: "Account type", value: ACCOUNT_TYPE_LABELS[account.type] ?? account.type },
    {
      label: "Sub-type",
      value:
        account.subtype === null
          ? "None"
          : (ACCOUNT_SUBTYPE_LABELS[account.subtype] ?? account.subtype),
    },
    {
      label: "Parent account",
      value: parent === undefined ? "None" : `${parent.code} — ${parent.name}`,
    },
    {
      label: "Normal balance",
      value: account.normalBalance === "debit" ? "Debit" : "Credit",
    },
    {
      label: "Status",
      value: account.isActive ? "Active" : "Inactive",
    },
    { label: "Description", value: account.description ?? "—" },
    { label: "Own balance", value: formatMoney(account.balanceFils) },
    { label: "Branch total", value: formatMoney(aggregatedFils) },
    { label: "Ledger lines", value: String(account.usageCount) },
    { label: "Created", value: formatDateTime(account.createdAt) },
    { label: "Last updated", value: formatDateTime(account.updatedAt) },
  ];

  return (
    <dl className="grid gap-x-6 gap-y-0 p-4 sm:grid-cols-2">
      {rows.map((row) => (
        <div
          key={row.label}
          className="flex items-baseline justify-between gap-4 border-b border-[var(--border)] py-2 last:border-b-0"
        >
          <dt className="text-[12.5px] text-[var(--text-3)]">{row.label}</dt>
          <dd className="tabular text-end text-[12.5px] font-medium text-[var(--text)]">
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** A date and time, read the way a person would say it. */
function formatDateTime(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "—";
  return parsed.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/* -------------------------------------------------------------------------- */
/* the originating transaction                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The journal entry behind a ledger line.
 *
 * The ledger says what happened to the account; the entry says what happened
 * to the business, with every side of it. Opening it is the difference between
 * "the cash account went up by 500" and "the customer paid the invoice".
 */
function JournalEntryDialog({
  entryId,
  onClose,
}: {
  readonly entryId: number | null;
  readonly onClose: () => void;
}): React.JSX.Element {
  const { data } = useQuery({
    queryKey: ["finance.journal", entryId],
    queryFn: () => call("finance.journal.get", { id: entryId ?? 0 }),
    enabled: entryId !== null,
  });

  const entry: JournalEntryDetailDto | undefined = data;

  return (
    <Dialog
      open={entryId !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={entry === undefined ? "Journal entry" : `Entry ${entry.entryNo}`}
      description={
        entry === undefined
          ? undefined
          : `${entry.entryDate} · ${JOURNAL_SOURCE_LABELS[entry.source] ?? entry.source} · ${
              entry.status === "reversed" ? "Reversed" : "Posted"
            }`
      }
      size="lg"
    >
      {entry === undefined ? (
        <p className="text-sm text-ink-secondary">Loading the entry…</p>
      ) : (
        <div className="space-y-3">
          <p className="text-[13px] text-[var(--text-2)]">{entry.description}</p>

          {entry.reference !== null && (
            <p className="text-[12.5px] text-[var(--text-3)]">Reference: {entry.reference}</p>
          )}

          <div className="overflow-hidden rounded-lg border border-[var(--border)]">
            <table className="w-full text-[13px]">
              <thead className="bg-[var(--table-header-bg)]">
                <tr>
                  <th
                    scope="col"
                    className="px-3 py-2 text-start text-[11.5px] font-semibold uppercase tracking-wide text-[var(--text-3)]"
                  >
                    Account
                  </th>
                  <th
                    scope="col"
                    className="px-3 py-2 text-start text-[11.5px] font-semibold uppercase tracking-wide text-[var(--text-3)]"
                  >
                    Description
                  </th>
                  <th
                    scope="col"
                    className="px-3 py-2 text-end text-[11.5px] font-semibold uppercase tracking-wide text-[var(--text-3)]"
                  >
                    Debit
                  </th>
                  <th
                    scope="col"
                    className="px-3 py-2 text-end text-[11.5px] font-semibold uppercase tracking-wide text-[var(--text-3)]"
                  >
                    Credit
                  </th>
                </tr>
              </thead>
              <tbody>
                {entry.lines.map((line) => (
                  <tr key={String(line.lineNo)} className="border-t border-[var(--border)]">
                    <td className="px-3 py-2">
                      <span className="tabular text-[var(--text-2)]">{line.accountCode}</span>{" "}
                      <span className="text-[var(--text)]">{line.accountName}</span>
                    </td>
                    <td className="px-3 py-2 text-[var(--text-2)]">{line.description ?? "—"}</td>
                    <td className="tabular px-3 py-2 text-end">
                      {line.debitFils === 0 ? "—" : formatAmount(line.debitFils)}
                    </td>
                    <td className="tabular px-3 py-2 text-end">
                      {line.creditFils === 0 ? "—" : formatAmount(line.creditFils)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-end gap-3 text-[12.5px] text-[var(--text-3)]">
            <span>
              Total debits {formatAmount(entry.totalDebitFils)} · credits{" "}
              {formatAmount(entry.totalCreditFils)}
            </span>
            <Tooltip content="The entry is part of the ledger and cannot be edited once posted.">
              <span className="cursor-help underline decoration-dotted underline-offset-2">
                Posted entries are corrected by a reversal
              </span>
            </Tooltip>
          </div>
        </div>
      )}
    </Dialog>
  );
}
