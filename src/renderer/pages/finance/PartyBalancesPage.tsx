/**
 * Customer receivables and supplier payables.
 *
 * The two screens are the same screen with the two ends of the ledger
 * swapped, so they share one component: the difference is which control
 * account the money sits in, and the direction of the running balance.
 *
 * Each screen shows three things:
 *
 *  - **Who owes what.** Every party with a balance, and how much of it is
 *    late.
 *  - **Aging.** The outstanding invoices grouped by how late they are, which
 *    is what tells a shop which customer to chase.
 *  - **The statement.** For one party, every movement: the invoice that
 *    increased what they owe, the receipt that reduced it, and the balance
 *    after each one.
 *
 * The statement is read from the ledger rather than from the invoice table,
 * so the closing balance is by construction the same number the control
 * account holds - which is what makes the reconciliation meaningful.
 */

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, FileText, Printer, Users } from "lucide-react";
import { toast } from "sonner";
import type { AgingBucket, PartyBalanceDto, PartyLedgerKind } from "../../../shared/finance";
import { call, errorMessage } from "../../lib/api";
import { useApp } from "../../lib/app-context";
import { formatAmount, formatMoney } from "../../lib/format";
import { statementDocumentHtml } from "../../lib/print-records";
import {
  DocumentPrintDialog,
  type PrintableDocument,
} from "../../components/print/DocumentPrintDialog";
import { Button } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { Dialog } from "../../components/ui/Dialog";
import { type Column, DataTable } from "../../components/ui/DataTable";
import { HighlightText } from "../../components/ui/HighlightText";
import { Badge } from "../../components/ui/Badge";
import { EmptyState, PageHeader, TableSkeleton } from "../../components/ui/Feedback";
import { Field, Input } from "../../components/ui/Input";
import { useSearchHighlight } from "../../lib/search-highlight";
import { DateRangePicker, FinanceLayout } from "./FinanceLayout";
import { DATE_RANGE_PRESETS, resolveDateRange, type DateRangePreset } from "../../lib/finance";

export function ReceivablesPage(): React.JSX.Element {
  return <PartyBalancesPage kind="customer" />;
}

export function PayablesPage(): React.JSX.Element {
  return <PartyBalancesPage kind="supplier" />;
}

const BUCKET_LABELS: Readonly<Record<AgingBucket, string>> = {
  notDue: "Not yet due",
  d1_30: "1–30 days",
  d31_60: "31–60 days",
  d61_90: "61–90 days",
  d90plus: "Over 90 days",
};

const balanceKey = (row: PartyBalanceDto): number => row.partyId;

/** Party balances are filtered in the renderer, so the name is the only field. */
const BALANCE_SEARCH_FIELDS = [(row: PartyBalanceDto) => row.partyName];

function PartyBalancesPage({ kind }: { readonly kind: PartyLedgerKind }): React.JSX.Element {
  const { can } = useApp();

  const [preset, setPreset] = useState<DateRangePreset>("month");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [search, setSearch] = useState("");
  const [statementFor, setStatementFor] = useState<PartyBalanceDto | null>(null);
  const [printing, setPrinting] = useState<PrintableDocument | null>(null);

  const range = useMemo(
    () => resolveDateRange(preset, customFrom, customTo),
    [preset, customFrom, customTo],
  );

  const isCustomer = kind === "customer";

  const { data, isLoading } = useQuery({
    queryKey: ["finance.partyBalances", kind, range.asOfDate],
    queryFn: () => call("finance.partyBalances", { kind, asOfDate: range.asOfDate }),
  });

  const { data: aging } = useQuery({
    queryKey: ["finance.aging", isCustomer ? "receivable" : "payable", range.asOfDate],
    queryFn: () =>
      call("finance.aging", {
        asOfDate: range.asOfDate,
        side: isCustomer ? "receivable" : "payable",
      }),
  });

  const balances = useMemo(() => data ?? [], [data]);

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (term.length === 0) return balances;
    return balances.filter((balance) => balance.partyName.toLowerCase().includes(term));
  }, [balances, search]);

  const highlight = useSearchHighlight(visible, search, {
    rowKey: balanceKey,
    fields: BALANCE_SEARCH_FIELDS,
  });

  const isSearching = search.trim().length > 0;

  const totals = useMemo(
    () => ({
      outstanding: balances.reduce((sum, balance) => sum + balance.outstandingFils, 0),
      overdue: balances.reduce((sum, balance) => sum + balance.overdueFils, 0),
    }),
    [balances],
  );

  const columns: readonly Column<PartyBalanceDto>[] = [
    {
      id: "party",
      header: isCustomer ? "Customer" : "Supplier",
      cell: (row) => (
        <span className="font-medium text-[var(--text)]">
          <HighlightText text={row.partyName} term={search} />
        </span>
      ),
      sortValue: (row) => row.partyName,
    },
    {
      id: "invoices",
      header: "Open invoices",
      align: "end",
      cell: (row) => <span className="tabular">{row.invoiceCount}</span>,
      sortValue: (row) => row.invoiceCount,
    },
    {
      id: "overdue",
      header: "Overdue",
      align: "end",
      cell: (row) =>
        row.overdueFils === 0 ? (
          <span className="text-[var(--text-3)]">—</span>
        ) : (
          <span className="tabular font-medium text-[var(--danger)]">
            {formatAmount(row.overdueFils)}
          </span>
        ),
      sortValue: (row) => row.overdueFils,
    },
    {
      id: "outstanding",
      header: "Outstanding",
      align: "end",
      cell: (row) => (
        <span className="tabular font-medium">{formatAmount(row.outstandingFils)}</span>
      ),
      sortValue: (row) => row.outstandingFils,
    },
    {
      id: "last",
      header: "Last movement",
      cell: (row) => (
        <span className="tabular text-[var(--text-2)]">{row.lastTransactionDate ?? "—"}</span>
      ),
      sortValue: (row) => row.lastTransactionDate ?? "",
    },
    {
      id: "actions",
      header: "",
      align: "end",
      widthClass: "w-20",
      cell: (row) => (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setStatementFor(row);
          }}
        >
          Statement
        </Button>
      ),
    },
  ];

  return (
    <FinanceLayout>
      <PageHeader
        title={isCustomer ? "Customer receivables" : "Supplier payables"}
        description={
          isCustomer
            ? "Who owes the business money, and how late they are."
            : "Who the business owes money, and how late it is."
        }
        actions={
          <DateRangePicker
            preset={preset}
            fromDate={customFrom}
            toDate={customTo}
            presets={DATE_RANGE_PRESETS}
            onPresetChange={(value) => {
              setPreset(value as DateRangePreset);
            }}
            onFromChange={setCustomFrom}
            onToChange={setCustomTo}
          />
        }
      />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card flush>
          <div className="flex flex-wrap items-center gap-2 border-b border-[var(--divider)] p-4">
            <div className="w-[240px]">
              <Field label="Search" srLabelOnly>
                {(id) => (
                  <Input
                    id={id}
                    value={search}
                    onChange={(event) => {
                      setSearch(event.target.value);
                    }}
                    placeholder="Name"
                  />
                )}
              </Field>
            </div>
            {balances.length > 0 && (
              <span className="ms-auto text-[12.5px] text-[var(--text-3)]">
                {isSearching
                  ? `${visible.length} of ${balances.length} ${isCustomer ? "customers" : "suppliers"}`
                  : `${balances.length} ${isCustomer ? "customers" : "suppliers"}`}{" "}
                · {formatMoney(totals.outstanding)} outstanding
                {totals.overdue > 0 && ` · ${formatMoney(totals.overdue)} overdue`}
              </span>
            )}
          </div>

          {isLoading ? (
            <div className="p-4">
              <TableSkeleton columns={5} rows={6} />
            </div>
          ) : (
            <DataTable
              frameless
              columns={columns}
              rows={visible}
              rowKey={balanceKey}
              highlightedRowKeys={highlight.keys}
              primaryRowKey={highlight.primaryKey}
              scrollToRowKey={highlight.primaryKey}
              caption={isCustomer ? "Customer receivables" : "Supplier payables"}
              compact
              emptyState={
                isSearching ? (
                  <EmptyState
                    compact
                    icon={<Users className="h-5 w-5" />}
                    title="No parties match"
                    description={`No ${isCustomer ? "customer" : "supplier"} name contains “${search.trim()}”. Clear the search to see every balance.`}
                  />
                ) : (
                  <EmptyState
                    compact
                    icon={<Users className="h-5 w-5" />}
                    title={isCustomer ? "Nothing is outstanding" : "Nothing is owed"}
                    description={
                      isCustomer
                        ? "Every customer invoice has been settled."
                        : "Every supplier bill has been paid."
                    }
                  />
                )
              }
            />
          )}
        </Card>

        <Card flush>
          <CardHeader title="Aging" description="How late the open invoices are." />
          {aging === undefined ? (
            <div className="p-4">
              <TableSkeleton columns={2} rows={5} />
            </div>
          ) : (
            <ul className="divide-y divide-[var(--border)]">
              {aging.buckets.map((bucket) => (
                <li
                  key={bucket.key}
                  className="flex items-center justify-between gap-4 px-5 py-2.5"
                >
                  <span className="text-[13px] text-[var(--text-2)]">
                    {BUCKET_LABELS[bucket.key] ?? bucket.label}
                  </span>
                  <span className="tabular text-[13.5px] font-medium text-[var(--text)]">
                    {formatAmount(bucket.amountFils)}
                  </span>
                </li>
              ))}
              <li className="flex items-center justify-between gap-4 bg-[var(--surface-2)] px-5 py-3">
                <span className="text-[13px] font-semibold text-[var(--text)]">
                  Total outstanding
                </span>
                <span className="tabular text-[14px] font-semibold text-[var(--text)]">
                  {formatAmount(aging.totalOutstandingFils)}
                </span>
              </li>
            </ul>
          )}
        </Card>
      </div>

      <StatementDialog
        party={statementFor}
        kind={kind}
        fromDate={range.fromDate}
        toDate={range.toDate}
        canExport={can("finance", "export")}
        onClose={() => {
          setStatementFor(null);
        }}
        onPrint={(document) => {
          setStatementFor(null);
          setPrinting(document);
        }}
      />

      <DocumentPrintDialog
        open={printing !== null}
        html={printing?.html ?? ""}
        title={printing?.title ?? ""}
        description={printing?.description}
        filename={printing?.filename ?? "document.pdf"}
        orientation={printing?.orientation}
        onClose={() => {
          setPrinting(null);
        }}
      />
    </FinanceLayout>
  );
}

/* -------------------------------------------------------------------------- */

function StatementDialog({
  party,
  kind,
  fromDate,
  toDate,
  canExport,
  onClose,
  onPrint,
}: {
  readonly party: PartyBalanceDto | null;
  readonly kind: PartyLedgerKind;
  readonly fromDate: string;
  readonly toDate: string;
  readonly canExport: boolean;
  readonly onClose: () => void;
  readonly onPrint: (document: PrintableDocument) => void;
}): React.JSX.Element {
  const { settings } = useApp();

  const { data, isLoading } = useQuery({
    queryKey: ["finance.partyStatement", party?.partyId ?? 0, kind, fromDate, toDate],
    queryFn: () =>
      call("finance.partyStatement", {
        partyId: party?.partyId ?? 0,
        kind,
        fromDate,
        toDate,
      }),
    enabled: party !== null,
  });

  const isCustomer = kind === "customer";

  return (
    <Dialog
      open={party !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={party === null ? "Statement" : `Statement — ${party.partyName}`}
      description={
        data === undefined
          ? undefined
          : `${data.fromDate} to ${data.toDate} · closing balance ${formatMoney(data.closingBalanceFils)}`
      }
      size="lg"
      footer={
        <>
          {data !== undefined && (
            <Button
              variant="primary"
              iconLeft={<Printer className="h-4 w-4" />}
              onClick={() => {
                // The document is shown first: printing is never a leap of faith.
                onPrint({
                  html: statementDocumentHtml(data, { settings }),
                  title: `Account Statement ${data.partyName}`,
                  description: `${data.fromDate} to ${data.toDate}`,
                  filename: `statement-${data.partyName}.pdf`,
                });
              }}
            >
              Print
            </Button>
          )}
          {canExport && party !== null && (
            <Button
              variant="secondary"
              iconLeft={<Download className="h-4 w-4" />}
              onClick={() => {
                void call("finance.export", {
                  dataset: isCustomer ? "customerStatement" : "supplierStatement",
                  partyId: party.partyId,
                  partyKind: kind,
                  fromDate,
                  toDate,
                })
                  .then((result) => {
                    toast.success(`Saved to ${result.path}`);
                  })
                  .catch((error: unknown) => {
                    toast.error(errorMessage(error));
                  });
              }}
            >
              Export
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      {isLoading ? (
        <TableSkeleton columns={5} rows={6} />
      ) : data === undefined ? null : (
        <>
          <div className="mb-3 grid gap-px overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--border)] sm:grid-cols-3">
            <SummaryCell
              label="Opening balance"
              value={formatMoney(data.openingBalanceFils)}
            />
            <SummaryCell
              label={isCustomer ? "Invoiced" : "Billed"}
              value={formatMoney(data.totalDebitFils)}
            />
            <SummaryCell
              label={isCustomer ? "Received" : "Paid"}
              value={formatMoney(data.totalCreditFils)}
            />
          </div>

          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-[var(--border)] text-[11.5px] uppercase tracking-wide text-[var(--text-3)]">
                <th scope="col" className="py-2 text-start">
                  Date
                </th>
                <th scope="col" className="py-2 text-start">
                  Reference
                </th>
                <th scope="col" className="py-2 text-start">
                  Description
                </th>
                <th scope="col" className="py-2 text-end">
                  Debit
                </th>
                <th scope="col" className="py-2 text-end">
                  Credit
                </th>
                <th scope="col" className="py-2 text-end">
                  Balance
                </th>
              </tr>
            </thead>
            <tbody>
              {data.rows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-6 text-center text-[var(--text-3)]">
                    No movements in this period.
                  </td>
                </tr>
              ) : (
                data.rows.map((row) => (
                  <tr
                    key={`${String(row.entryId)}-${String(row.entryNo)}`}
                    className="border-b border-[var(--divider)] last:border-0"
                  >
                    <td className="tabular py-2 pe-2 text-[var(--text-2)]">{row.entryDate}</td>
                    <td className="tabular py-2 pe-2 text-[var(--text-2)]">
                      {row.documentNumber ?? row.reference ?? row.entryNo}
                    </td>
                    <td className="py-2 pe-2">
                      <span className="text-[var(--text)]">{row.description}</span>
                      {row.kind === "invoice" && row.isSettled === false && (
                        <Badge tone="warning" className="ms-2">
                          Unpaid
                        </Badge>
                      )}
                    </td>
                    <td className="tabular py-2 text-end">
                      {row.debitFils === 0 ? "—" : formatAmount(row.debitFils)}
                    </td>
                    <td className="tabular py-2 text-end">
                      {row.creditFils === 0 ? "—" : formatAmount(row.creditFils)}
                    </td>
                    <td className="tabular py-2 text-end font-medium">
                      {formatAmount(row.runningBalanceFils)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </>
      )}
    </Dialog>
  );
}

function SummaryCell({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): React.JSX.Element {
  return (
    <div className="bg-[var(--surface)] px-4 py-2.5">
      <p className="text-[11.5px] uppercase tracking-wide text-[var(--text-3)]">{label}</p>
      <p className="tabular mt-0.5 text-[15px] font-semibold text-[var(--text)]">{value}</p>
    </div>
  );
}

export { FileText };
